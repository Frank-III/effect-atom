/**
 * Signal-based Atom implementation
 * This is the new reactive system using the TC39 Signal proposal
 *
 * @since 2.0.0
 */

import type * as Cause from "effect/Cause"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Inspectable from "effect/Inspectable"
import type * as Option from "effect/Option"
import { pipeArguments } from "effect/Pipeable"
import type { Pipeable } from "effect/Pipeable"
import { hasProperty } from "effect/Predicate"
import * as Runtime from "effect/Runtime"
import * as Stream from "effect/Stream"
import { Signal } from "signal-polyfill"
import { runCallbackSync } from "./internal/runtime.js"
import { batch, createEffect } from "./internal/signal-effect.js"
import * as Registry from "./Registry.js"
import * as Result from "./Result.js"

/**
 * @since 2.0.0
 * @category type ids
 */
export const TypeId: unique symbol = Symbol.for("@effect-atom/atom/Atom")

/**
 * @since 2.0.0
 * @category type ids
 */
export type TypeId = typeof TypeId

/**
 * @since 2.0.0
 * @category models
 */
export interface Atom<A> extends Pipeable, Inspectable.Inspectable {
  readonly [TypeId]: TypeId
  readonly signal: Signal.State<A> | Signal.Computed<A>
  readonly read: (get: Context) => A
  readonly keepAlive: boolean
  readonly lazy: boolean
  readonly label?: readonly [name: string, stack: string]
  readonly idleTTL?: number
  readonly refresh?: (f: <A>(atom: Atom<A>) => void) => void
}

/**
 * @since 2.0.0
 * @category type ids
 */
export const WritableTypeId: unique symbol = Symbol.for("@effect-atom/atom/Atom/Writable")

/**
 * @since 2.0.0
 * @category type ids
 */
export type WritableTypeId = typeof WritableTypeId

/**
 * @since 2.0.0
 * @category models
 */
export interface Writable<R, W = R> extends Atom<R> {
  readonly [WritableTypeId]: WritableTypeId
  readonly signal: Signal.State<R>
  readonly write: {
    (ctx: WriteContext<R>, value: W): void
    (value: W): void
  }
}

/**
 * @since 2.0.0
 * @category context
 */
export interface Context {
  <A>(atom: Atom<A>): A
  get<A>(this: Context, atom: Atom<A>): A
  once<A>(this: Context, atom: Atom<A>): A
  set<R, W>(this: Context, atom: Writable<R, W>, value: W): void
  setSelf<A>(this: Context, a: A): void
  self<A>(this: Context): Option.Option<A>
  mount<A>(this: Context, atom: Atom<A>): void
  refresh<A>(this: Context, atom: Atom<A>): void
  refreshSelf(this: Context): void
  addFinalizer(this: Context, f: () => void): void
  subscribe<A>(this: Context, atom: Atom<A>, f: (_: A) => void, options?: {
    readonly immediate?: boolean
  }): void
  readonly registry: Registry.Registry

  // Result helpers
  result<A, E>(this: Context, atom: Atom<Result.Result<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): Effect.Effect<A, E>
  resultOnce<A, E>(this: Context, atom: Atom<Result.Result<A, E>>, options?: {
    readonly suspendOnWaiting?: boolean | undefined
  }): Effect.Effect<A, E>
  some<A>(this: Context, atom: Atom<Option.Option<A>>): Effect.Effect<A>
  someOnce<A>(this: Context, atom: Atom<Option.Option<A>>): Effect.Effect<A>

  // Stream helpers
  stream<A>(this: Context, atom: Atom<A>, options?: {
    readonly withoutInitialValue?: boolean
    readonly bufferSize?: number
  }): Stream.Stream<A>
  streamResult<A, E>(this: Context, atom: Atom<Result.Result<A, E>>, options?: {
    readonly withoutInitialValue?: boolean
    readonly bufferSize?: number
  }): Stream.Stream<A, E>
}

/**
 * @since 2.0.0
 * @category context
 */
export interface WriteContext<A> {
  get<T>(this: WriteContext<A>, atom: Atom<T>): T
  refreshSelf(this: WriteContext<A>): void
  setSelf(this: WriteContext<A>, a: A): void
  set<R, W>(this: WriteContext<A>, atom: Writable<R, W>, value: W): void
}

/**
 * @since 2.0.0
 * @category Guards
 */
export const isAtom = (u: unknown): u is Atom<any> => hasProperty(u, TypeId)

/**
 * @since 2.0.0
 * @category Guards
 */
export const isWritable = <R, W = R>(atom: Atom<R>): atom is Writable<R, W> => WritableTypeId in atom

/**
 * Extract the value type from an Atom
 * @since 2.0.0
 */
export type Type<T extends Atom<any>> = T extends Atom<infer A> ? A : never

/**
 * Extract the success type from a Result Atom
 * @since 2.0.0
 */
export type Success<T extends Atom<any>> = T extends Atom<Result.Result<infer A, infer _>> ? A : never

/**
 * Extract the failure type from a Result Atom
 * @since 2.0.0
 */
export type Failure<T extends Atom<any>> = T extends Atom<Result.Result<infer _, infer E>> ? E : never

/**
 * Base prototype for Atoms
 */
const AtomProto = {
  [TypeId]: TypeId,
  pipe() {
    return pipeArguments(this, arguments)
  },
  toJSON(this: Atom<any>) {
    return {
      _id: "Atom",
      keepAlive: this.keepAlive,
      lazy: this.lazy,
      label: this.label
    }
  },
  toString() {
    return Inspectable.format(this)
  },
  [Inspectable.NodeInspectSymbol](this: Atom<any>) {
    return this.toJSON()
  }
} as const

const WritableProto = {
  ...AtomProto,
  [WritableTypeId]: WritableTypeId
} as const

/**
 * Create a readable atom
 * @since 2.0.0
 * @category constructors
 */
export const readable = <A>(
  read: (get: Context) => A,
  refresh?: (f: <A>(atom: Atom<A>) => void) => void
): Atom<A> => {
  // Don't create a signal here - let the registry handle it
  const atom = Object.create(AtomProto)
  atom.read = read
  atom.keepAlive = false
  atom.lazy = true
  atom.refresh = refresh

  return atom
}

/**
 * Create a writable computed atom
 * @since 2.0.0
 * @category constructors
 */
export const writableComputed = <R, W = R>(
  read: () => R,
  write: (value: W) => void
): Writable<R, W> => {
  // Track version to force updates
  const versionSignal = new Signal.State(0)

  // Create a computed signal that reads the external value
  const computedSignal = new Signal.Computed(() => {
    // Depend on version to re-execute when write happens
    versionSignal.get()
    return read()
  })

  // Create a proxy object that looks like a State signal
  const signalProxy = {
    get: () => computedSignal.get(),
    set: (value: R) => {
      // This shouldn't be called directly
      throw new Error("Cannot set a computed signal directly")
    }
  }

  const atom = Object.create(WritableProto)
  atom.signal = signalProxy
  atom.read = () => computedSignal.get()
  atom.write = (_: WriteContext<R>, value: W) => {
    batch(() => {
      write(value)
      // Increment version to trigger recomputation
      versionSignal.set(versionSignal.get() + 1)
    })
  } // Add direct write method on atom for convenience
  ;(atom as any).write = (value: W) => {
    batch(() => {
      write(value)
      // Increment version to trigger recomputation
      versionSignal.set(versionSignal.get() + 1)
    })
  }
  atom.keepAlive = false
  atom.lazy = true

  return atom
}

/**
 * Create a writable atom (state atom)
 * @since 2.0.0
 * @category constructors
 */
export const writable = <R, W = R>(
  read: (get: Context) => R,
  write: (ctx: WriteContext<R>, value: W) => void,
  refresh?: (f: <A>(atom: Atom<A>) => void) => void
): Writable<R, W> => {
  // For writable atoms, we use a State signal
  const signal = new Signal.State<R>(undefined as any)

  // Initialize with read value
  const initialValue = read({} as Context)
  signal.set(initialValue)

  const atom = Object.create(WritableProto)
  atom.signal = signal
  atom.read = read
  atom.write = write
  atom.keepAlive = false
  atom.lazy = true
  atom.refresh = refresh

  return atom
}

/**
 * Get server value for an atom (for SSR support)
 * @since 2.0.0
 * @category utils
 */
export const getServerValue = <A>(atom: Atom<A>, registry: any): A => {
  // For now, just return the current value from the registry
  return registry.get(atom)
}

/**
 * Make atom serializable (stub for now)
 * @since 2.0.0
 * @category utils
 */
export const serializable = (config: any) => (atom: Atom<any>) => atom

/**
 * Create a simple state atom
 * @since 2.0.0
 * @category constructors
 */
export const state = <A>(initialValue: A): Writable<A> => {
  const signal = new Signal.State(initialValue)

  const atom = Object.create(WritableProto) as any
  atom.signal = signal
  atom.read = () => signal.get()
  atom.write = (_: WriteContext<A>, value: A) => {
    batch(() => signal.set(value))
  } // Add direct write method on atom for convenience
  ;(atom as any).write = (value: A) => {
    batch(() => signal.set(value))
  }
  atom.keepAlive = false
  atom.lazy = true

  return atom
}

/**
 * Create a computed atom (readonly)
 * @since 2.0.0
 * @category constructors
 */
export const computed = <A>(compute: () => A): Atom<A> => {
  const signal = new Signal.Computed(compute)

  const atom = Object.create(AtomProto)
  atom.signal = signal
  atom.read = () => signal.get()
  atom.keepAlive = false
  atom.lazy = true

  return atom
}

/**
 * Create an atom from a value or function
 * @since 2.0.0
 * @category constructors
 */
export const make: {
  <A>(compute: (get: Context) => A): Atom<A>
  <A>(initialValue: A): Writable<A>
  <A, E>(effectValue: Effect.Effect<A, E>): Atom<any>
} = <A>(arg: A | ((get: Context) => A) | Effect.Effect<A, any>): any => {
  // Handle Effect-based atoms
  if (Effect.isEffect(arg)) {
    return effect(() => arg as Effect.Effect<A, any>)
  }
  if (typeof arg === "function") {
    return readable(arg as (get: Context) => A)
  }
  return state(arg)
}

/**
 * Derive an atom from multiple atoms
 * @since 2.0.0
 * @category combinators
 */
export const derive = <Deps extends ReadonlyArray<Atom<any>>, A>(
  deps: Deps,
  compute: (...values: { [K in keyof Deps]: Deps[K] extends Atom<infer T> ? T : never }) => A
): Atom<A> => {
  return computed(() => {
    const values = deps.map((dep) => dep.signal.get()) as any
    return compute(...values)
  })
}

/**
 * FlatMap for atoms (monadic bind)
 * @since 2.0.0
 * @category combinators
 */
export const flatMap = <A, B>(
  self: Atom<A>,
  f: (a: A) => Atom<B>
): Atom<B> =>
  computed(() => {
    const innerAtom = f(self.signal.get())
    return innerAtom.signal.get()
  })

/**
 * Map over an atom's value
 * @since 2.0.0
 * @category combinators
 */
export const map = <A, B>(
  self: Atom<A>,
  f: (a: A) => B
): Atom<B> => computed(() => f(self.signal.get()))

/**
 * Transform an atom using a context
 * @since 2.0.0
 * @category combinators
 */
export const transform = <A, B>(
  self: Atom<A>,
  f: (get: Context) => B
): Atom<B> => readable(f)

/**
 * Keep an atom alive (prevent disposal)
 * @since 2.0.0
 * @category combinators
 */
export const keepAlive = <A extends Atom<any>>(self: A): A =>
  Object.assign(Object.create(Object.getPrototypeOf(self)), {
    ...self,
    keepAlive: true
  })

/**
 * Set atom label for debugging
 * @since 2.0.0
 * @category combinators
 */
export const withLabel = <A extends Atom<any>>(self: A, name: string): A =>
  Object.assign(Object.create(Object.getPrototypeOf(self)), {
    ...self,
    label: [name, new Error().stack?.split("\n")[3] ?? ""]
  })

/**
 * Set idle TTL for an atom
 * @since 2.0.0
 * @category combinators
 */
export const setIdleTTL = <A extends Atom<any>>(
  self: A,
  duration: Duration.DurationInput
): A => {
  const millis = Duration.toMillis(Duration.decode(duration))
  return Object.assign(Object.create(Object.getPrototypeOf(self)), {
    ...self,
    keepAlive: false,
    idleTTL: millis
  })
}

/**
 * Create a family of atoms with caching
 * @since 2.0.0
 * @category constructors
 */
export const family = <Arg, A>(
  f: (arg: Arg) => Atom<A>
): (arg: Arg) => Atom<A> => {
  const cache = new Map<Arg, Atom<A>>()

  return (arg: Arg) => {
    let atom = cache.get(arg)

    if (!atom) {
      atom = f(arg)
      cache.set(arg, atom)
    }

    return atom
  }
}

/**
 * Subscribe to atom changes
 * @since 2.0.0
 * @category subscriptions
 */
export const subscribe = <A>(
  atom: Atom<A>,
  callback: (value: A) => void,
  options?: { immediate?: boolean }
): () => void => {
  let isFirstCall = true

  return createEffect(() => {
    const value = atom.signal.get()

    // Skip first call unless immediate is true
    if (isFirstCall) {
      isFirstCall = false
      if (options?.immediate) {
        callback(value)
      }
      return
    }

    callback(value)
  }, { immediate: true })
}

/**
 * Create an atom that runs an Effect
 * @since 2.0.0
 * @category constructors
 */
export const effect = <A, E>(
  eff: Effect.Effect<A, E> | ((get: Context) => Effect.Effect<A, E>),
  options?: { initialValue?: A }
): Atom<Result.Result<A, E>> => {
  const resultSignal = new Signal.State<Result.Result<A, E>>(
    options?.initialValue !== undefined
      ? Result.success(options.initialValue)
      : Result.initial()
  )

  // Run the effect
  let cancel: (() => void) | undefined

  const runEffect = () => {
    const actualEffect = typeof eff === "function" ? eff({} as Context) : eff

    // Mark as waiting
    resultSignal.set(Result.waiting(resultSignal.get()))

    // Run the effect
    cancel = runCallbackSync(Runtime.defaultRuntime)(actualEffect, (exit) => {
      resultSignal.set(Result.fromExit(exit))
    })
  }

  // Initial run
  runEffect()

  const atom = Object.create(AtomProto)
  atom.signal = resultSignal
  atom.read = () => resultSignal.get()
  atom.keepAlive = false
  atom.lazy = true
  atom.refresh = () => {
    if (cancel) {
      cancel()
    }
    runEffect()
  }

  return atom
}

/**
 * Create a stream atom
 * @since 2.0.0
 * @category constructors
 */
export const stream = <A, E>(
  str: Stream.Stream<A, E> | ((get: Context) => Stream.Stream<A, E>),
  options?: { initialValue?: A }
): Atom<Result.Result<A, E | Cause.NoSuchElementException>> => {
  const resultSignal = new Signal.State<Result.Result<A, E | Cause.NoSuchElementException>>(
    options?.initialValue !== undefined
      ? Result.success(options.initialValue)
      : Result.initial()
  )

  // Run the stream
  let cancel: (() => void) | undefined

  const runStream = () => {
    const actualStream = typeof str === "function" ? str({} as Context) : str

    // Mark as waiting
    resultSignal.set(Result.waiting(resultSignal.get()))

    // Run the stream
    const runtime = Runtime.defaultRuntime
    cancel = runCallbackSync(runtime)(
      Stream.runForEach(actualStream, (value) => {
        resultSignal.set(Result.success(value))
        return Effect.void
      }).pipe(
        Effect.catchAll((error) => {
          resultSignal.set(Result.fail(error))
          return Effect.void
        })
      ),
      (exit) => {
        // Stream completed or failed
        if (exit._tag === "Failure") {
          resultSignal.set(Result.failure(exit.cause))
        }
      }
    )
  }

  // Initial run
  runStream()

  const atom = Object.create(AtomProto)
  atom.signal = resultSignal
  atom.read = () => resultSignal.get()
  atom.keepAlive = false
  atom.lazy = true
  atom.refresh = () => {
    if (cancel) {
      cancel()
    }
    runStream()
  }

  return atom
}

/**
 * Batch multiple updates
 * @since 2.0.0
 * @category batching
 */
export { batch } from "./internal/signal-effect.js"

// Re-export useful symbols and functions for compatibility
export const Reset = Symbol.for("@effect-atom/atom/Atom/Reset")
export type Reset = typeof Reset

export const Interrupt = Symbol.for("@effect-atom/atom/Atom/Interrupt")
export type Interrupt = typeof Interrupt

/**
 * Get atom value in Effect context
 * @since 2.0.0
 * @category conversions
 */
export const get = <A>(self: Atom<A>): Effect.Effect<A, never, Registry.AtomRegistry> =>
  Effect.map(Registry.AtomRegistry, (_) => _.get(self))

/**
 * Set atom value in Effect context
 * @since 2.0.0
 * @category conversions
 */
export const set = <R, W>(
  self: Writable<R, W>,
  value: W
): Effect.Effect<void, never, Registry.AtomRegistry> => Effect.map(Registry.AtomRegistry, (_) => _.set(self, value))

/**
 * Update atom value in Effect context
 * @since 2.0.0
 * @category conversions
 */
export const update = <R, W>(
  self: Writable<R, W>,
  f: (value: R) => W
): Effect.Effect<void, never, Registry.AtomRegistry> => Effect.map(Registry.AtomRegistry, (_) => _.update(self, f))

/**
 * Refresh an atom
 * @since 2.0.0
 * @category conversions
 */
export const refresh = <A>(self: Atom<A>): Effect.Effect<void, never, Registry.AtomRegistry> =>
  Effect.map(Registry.AtomRegistry, (_) => _.refresh(self))
