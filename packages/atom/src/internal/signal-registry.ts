/**
 * Signal-based Registry implementation
 * This replaces the current node-based registry with a Signal-powered one
 */

import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import { Signal } from "signal-polyfill"
import type * as Atom from "../Atom.js"
import * as Registry from "../Registry.js"
import * as Result from "../Result.js"
import { batch, createEffect } from "./signal-effect.js"

export const TypeId = Registry.TypeId

/**
 * Signal-based node for storing atom state
 */
class SignalNode<A> {
  private signal: Signal.State<A> | Signal.Computed<A>
  private listeners = new Set<(value: A) => void>()
  private disposeEffect?: () => void

  constructor(
    private readonly atom: Atom.Atom<A>,
    private readonly registry: SignalRegistry
  ) {
    // Check if atom already has a signal (state atoms)
    if ((atom as any).signal) {
      // Use the atom's existing signal directly
      this.signal = (atom as any).signal
    } else if ("write" in atom && atom.write) {
      // Create a state signal for other writable atoms
      const initialValue = this.computeInitialValue()
      this.signal = new Signal.State(initialValue)
    } else {
      // Create a computed signal for readonly atoms
      this.signal = new Signal.Computed(() => this.computeValue())
    }
  }

  private computeInitialValue(): A {
    // For atoms with signals, just get the value directly
    if ((this.atom as any).signal) {
      return (this.atom as any).signal.get()
    }
    // Create a temporary context to compute initial value
    const context = this.registry.createContext()
    return this.atom.read(context)
  }

  private computeValue(): A {
    // For atoms with signals, just get the value directly
    if ((this.atom as any).signal) {
      return (this.atom as any).signal.get()
    }
    const context = this.registry.createContext()
    return this.atom.read(context)
  }

  get(): A {
    return this.signal.get()
  }

  set(value: A): void {
    if (this.signal instanceof Signal.State) {
      this.signal.set(value)
      // No need to manually notify - the effect will handle it
    }
  }

  subscribe(listener: (value: A) => void): () => void {
    this.listeners.add(listener)

    // Start watching this signal if this is the first listener
    if (this.listeners.size === 1) {
      this.startWatching()
    }

    return () => {
      this.listeners.delete(listener)

      // Stop watching if no more listeners
      if (this.listeners.size === 0) {
        this.stopWatching()
      }
    }
  }

  private startWatching(): void {
    // Use the effect system to watch for changes
    let previousValue = this.signal.get()
    this.disposeEffect = createEffect(() => {
      const value = this.signal.get()
      // Only notify if value actually changed
      if (value !== previousValue) {
        previousValue = value
        this.notifyListeners(value)
      }
    }, { immediate: true })
  }

  private stopWatching(): void {
    if (this.disposeEffect) {
      this.disposeEffect()
      this.disposeEffect = undefined
    }
  }

  private notifyListeners(value: A): void {
    for (const listener of this.listeners) {
      listener(value)
    }
  }

  dispose(): void {
    this.stopWatching()
    this.listeners.clear()
  }
}

/**
 * Signal-based Registry implementation
 */
export class SignalRegistry implements Registry.Registry {
  readonly [Registry.TypeId]: Registry.TypeId
  private nodes = new Map<Atom.Atom<any>, SignalNode<any>>()
  private disposed = false

  constructor(
    initialValues?: Iterable<readonly [Atom.Atom<any>, any]>,
    scheduleTask = (cb: () => void): void => queueMicrotask(cb),
    readonly timeoutResolution = 1000,
    readonly defaultIdleTTL?: number
  ) {
    this[Registry.TypeId] = Registry.TypeId

    // Set initial values
    if (initialValues) {
      for (const [atom, value] of initialValues) {
        this.ensureNode(atom).set(value)
      }
    }
  }

  createContext(): Atom.Context {
    const self = this
    const finalizers = new Set<() => void>()
    let currentSelf: any = undefined

    const context: Atom.Context = function<A>(atom: Atom.Atom<A>): A {
      return context.get(atom)
    } as Atom.Context

    context.get = <A>(atom: Atom.Atom<A>): A => {
      return self.ensureNode(atom).get()
    }

    context.once = <A>(atom: Atom.Atom<A>): A => {
      // For now, once is the same as get
      // This could be optimized later
      return context.get(atom)
    }

    context.set = <R, W>(atom: Atom.Writable<R, W>, value: W): void => {
      self.ensureNode(atom) // Ensure node exists
      if ("write" in atom && atom.write) {
        const writeContext = self.createWriteContext(atom)
        atom.write(writeContext, value)
      }
    }

    context.setSelf = <A>(value: A): void => {
      currentSelf = value
    }

    context.self = <A>(): Option.Option<A> => {
      return currentSelf !== undefined ? Option.some(currentSelf) : Option.none()
    }

    context.mount = <A>(atom: Atom.Atom<A>): void => {
      self.mount(atom)
    }

    context.refresh = <A>(atom: Atom.Atom<A>): void => {
      self.refresh(atom)
    }

    context.refreshSelf = (): void => {
      // Implementation depends on the current atom being computed
      // This would need to be set by the atom system
      // For now, it's a no-op
    }

    context.addFinalizer = (f: () => void): void => {
      finalizers.add(f)
    }

    context.subscribe = <A>(atom: Atom.Atom<A>, f: (value: A) => void, options?: { immediate?: boolean }): void => {
      const atomNode = self.ensureNode(atom)

      if (options?.immediate) {
        f(atomNode.get())
      }

      const unsubscribe = atomNode.subscribe(f)
      finalizers.add(unsubscribe)
    } // registry property
    ;(context as any).registry = self

    context.result = <A, E>(
      atom: Atom.Atom<Result.Result<A, E>>,
      options?: { suspendOnWaiting?: boolean }
    ): Effect.Effect<A, E> => {
      const result = context.get(atom)
      // Convert Result to Effect
      const exit = Result.toExit(result)
      return exit._tag === "Success"
        ? Effect.succeed(exit.value) as Effect.Effect<A, E>
        : Effect.failCause(exit.cause) as Effect.Effect<A, E>
    }

    context.resultOnce = <A, E>(
      atom: Atom.Atom<Result.Result<A, E>>,
      options?: { suspendOnWaiting?: boolean }
    ): Effect.Effect<A, E> => {
      const result = context.once(atom)
      // Convert Result to Effect
      const exit = Result.toExit(result)
      return exit._tag === "Success"
        ? Effect.succeed(exit.value) as Effect.Effect<A, E>
        : Effect.failCause(exit.cause) as Effect.Effect<A, E>
    }

    context.some = <A>(atom: Atom.Atom<Option.Option<A>>): Effect.Effect<A> => {
      const option = context.get(atom)
      return Option.match(option, {
        onNone: () => Effect.fail(new Cause.NoSuchElementException()) as unknown as Effect.Effect<A>,
        onSome: (value) => Effect.succeed(value) as unknown as Effect.Effect<A>
      })
    }

    context.someOnce = <A>(atom: Atom.Atom<Option.Option<A>>): Effect.Effect<A> => {
      const option = context.once(atom)
      return Option.match(option, {
        onNone: () => Effect.fail(new Cause.NoSuchElementException()) as unknown as Effect.Effect<A>,
        onSome: (value) => Effect.succeed(value) as unknown as Effect.Effect<A>
      })
    }

    context.stream = <A>(
      atom: Atom.Atom<A>,
      options?: { withoutInitialValue?: boolean; bufferSize?: number }
    ): Stream.Stream<A> => {
      return Stream.async<A>((emit) => {
        const node = self.ensureNode(atom)

        if (!options?.withoutInitialValue) {
          emit.single(node.get())
        }

        const unsubscribe = node.subscribe((value) => {
          emit.single(value)
        })

        return Effect.sync(() => {
          unsubscribe()
          emit.end()
        })
      })
    }

    context.streamResult = <A, E>(
      atom: Atom.Atom<Result.Result<A, E>>,
      options?: { withoutInitialValue?: boolean; bufferSize?: number }
    ): Stream.Stream<A, E> => {
      return Stream.flatMap(
        context.stream(atom, options),
        (result) => {
          const exit = Result.toExit(result)
          const effect = exit._tag === "Success" ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)
          return Stream.fromEffect(effect) as Stream.Stream<A, E>
        }
      ) as Stream.Stream<A, E>
    }

    return context
  }

  private createWriteContext<R>(atom: Atom.Writable<R, any>): Atom.WriteContext<R> {
    const self = this
    const node = this.ensureNode(atom)

    const writeContext: Atom.WriteContext<R> = {
      get<T>(atom: Atom.Atom<T>): T {
        return self.ensureNode(atom).get()
      },

      refreshSelf(): void {
        self.refresh(atom)
      },

      setSelf(value: R): void {
        node.set(value)
      },

      set<R2, W>(atom: Atom.Writable<R2, W>, value: W): void {
        self.set(atom, value)
      }
    }

    return writeContext
  }

  ensureNode<A>(atom: Atom.Atom<A>): SignalNode<A> {
    if (this.disposed) {
      throw new Error("Registry is disposed")
    }

    let node = this.nodes.get(atom)

    if (!node) {
      node = new SignalNode(atom, this)
      this.nodes.set(atom, node)
    }

    return node
  }

  getNodes(): Map<Atom.Atom<any> | string, any> {
    // Convert to the expected format for compatibility
    const result = new Map()
    for (const [atom, node] of this.nodes) {
      result.set(atom, node)
    }
    return result
  }

  get<A>(atom: Atom.Atom<A>): A {
    return this.ensureNode(atom).get()
  }

  set<R, W>(atom: Atom.Writable<R, W>, value: W): void {
    batch(() => {
      const writeContext = this.createWriteContext(atom)
      atom.write(writeContext, value)
    })
  }

  modify<R, W, A>(atom: Atom.Writable<R, W>, f: (value: R) => [A, W]): A {
    const current = this.get(atom)
    const [result, newValue] = f(current)
    this.set(atom, newValue)
    return result
  }

  update<R, W>(atom: Atom.Writable<R, W>, f: (value: R) => W): void {
    const current = this.get(atom)
    this.set(atom, f(current))
  }

  refresh<A>(atom: Atom.Atom<A>): void {
    if (atom.refresh) {
      atom.refresh((a) => this.refresh(a))
    } else {
      // Force recomputation by invalidating the node
      const node = this.nodes.get(atom)
      if (node) {
        // Trigger a re-read
        node.get()
      }
    }
  }

  subscribe<A>(atom: Atom.Atom<A>, f: (value: A) => void, options?: { immediate?: boolean }): () => void {
    const node = this.ensureNode(atom)

    if (options?.immediate) {
      f(node.get())
    }

    return node.subscribe(f)
  }

  mount<A>(atom: Atom.Atom<A>): () => void {
    // Mount just ensures the atom exists and stays alive
    this.ensureNode(atom)

    // Return a no-op dispose function
    return () => {}
  }

  reset(): void {
    // Clear all nodes and start fresh
    for (const node of this.nodes.values()) {
      node.dispose()
    }
    this.nodes.clear()
  }

  dispose(): void {
    if (this.disposed) return

    this.disposed = true

    for (const node of this.nodes.values()) {
      node.dispose()
    }

    this.nodes.clear()
  }

  setSerializable(key: string, encoded: unknown): void {
    // This would need implementation for serializable atoms
    // For now, it's a no-op
  }
}

/**
 * Create a new Signal-based registry
 */
export const makeSignalRegistry = (options?: {
  readonly initialValues?: Iterable<readonly [Atom.Atom<any>, any]>
  readonly scheduleTask?: (f: () => void) => void
  readonly timeoutResolution?: number
  readonly defaultIdleTTL?: number
}): Registry.Registry => {
  return new SignalRegistry(
    options?.initialValues,
    options?.scheduleTask,
    options?.timeoutResolution,
    options?.defaultIdleTTL
  )
}
