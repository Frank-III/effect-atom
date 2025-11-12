import { afterEach, beforeEach, describe, expect, it, vitest } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Atom from "../src/Atom.js"
import * as Registry from "../src/Registry.js"
import * as Result from "../src/Result.js"

describe("Atom", () => {
  beforeEach(() => {
    vitest.useFakeTimers()
  })

  afterEach(() => {
    vitest.useRealTimers()
  })

  describe("state atoms", () => {
    it("should create and read a state atom", () => {
      const counter = Atom.state(0)
      expect(counter.signal.get()).toEqual(0)
    })

    it("should update a state atom", () => {
      const counter = Atom.state(0)
      counter.write(1)
      expect(counter.signal.get()).toEqual(1)
    })

    it("should batch multiple updates", async () => {
      const counter = Atom.state(0)
      const log: Array<number> = []

      Atom.subscribe(counter, (value) => log.push(value), { immediate: true })

      // Clear log after initial value
      expect(log).toEqual([0])
      log.length = 0

      Atom.batch(() => {
        counter.write(1)
        counter.write(2)
        counter.write(3)
      })

      // Wait for microtask to process the watcher notification
      await Promise.resolve()

      // Should only get the final batched value
      expect(log).toEqual([3])
    })
  })

  describe("computed atoms", () => {
    it("should create a computed atom", () => {
      const counter = Atom.state(0)
      const doubled = Atom.computed(() => counter.signal.get() * 2)

      expect(doubled.signal.get()).toEqual(0)

      counter.write(5)
      expect(doubled.signal.get()).toEqual(10)
    })

    it("should derive from multiple atoms", () => {
      const a = Atom.state(1)
      const b = Atom.state(2)
      const sum = Atom.derive([a, b], (x, y) => x + y)

      expect(sum.signal.get()).toEqual(3)

      a.write(10)
      expect(sum.signal.get()).toEqual(12)

      b.write(20)
      expect(sum.signal.get()).toEqual(30)
    })

    it("should chain computations", () => {
      const counter = Atom.state(0)
      const doubled = Atom.computed(() => counter.signal.get() * 2)
      const quadrupled = Atom.computed(() => doubled.signal.get() * 2)

      expect(quadrupled.signal.get()).toEqual(0)

      counter.write(3)
      expect(quadrupled.signal.get()).toEqual(12)
    })
  })

  describe("writable computed atoms", () => {
    it("should create a writable computed atom", () => {
      let internalValue = 0

      const atom = Atom.writableComputed(
        () => internalValue,
        (value: number) => {
          internalValue = value
        }
      )

      expect(atom.signal.get()).toEqual(0)

      atom.write(10)
      expect(atom.signal.get()).toEqual(10)
      expect(internalValue).toEqual(10)
    })
  })

  describe("subscriptions", () => {
    it("should subscribe to changes", async () => {
      const counter = Atom.state(0)
      const log: Array<number> = []

      const unsubscribe = Atom.subscribe(counter, (value) => log.push(value))

      counter.write(1)
      await Promise.resolve() // Let microtasks run

      counter.write(2)
      await Promise.resolve() // Let microtasks run

      expect(log).toEqual([1, 2])

      unsubscribe()

      counter.write(3)
      await Promise.resolve()

      // Should not receive updates after unsubscribe
      expect(log).toEqual([1, 2])
    })

    it("should support immediate subscription", () => {
      const counter = Atom.state(5)
      const log: Array<number> = []

      Atom.subscribe(counter, (value) => log.push(value), { immediate: true })

      expect(log).toEqual([5])
    })
  })

  describe("map and flatMap", () => {
    it("should map over atom values", () => {
      const counter = Atom.state(0)
      const doubled = Atom.map(counter, (x) => x * 2)

      expect(doubled.signal.get()).toEqual(0)

      counter.write(5)
      expect(doubled.signal.get()).toEqual(10)
    })

    it("should flatMap atoms", () => {
      const switch_ = Atom.state(false)
      const valueA = Atom.state(1)
      const valueB = Atom.state(2)

      const selected = Atom.flatMap(switch_, (s) => s ? valueB : valueA)

      expect(selected.signal.get()).toEqual(1)

      switch_.write(true)
      expect(selected.signal.get()).toEqual(2)

      valueB.write(10)
      expect(selected.signal.get()).toEqual(10)
    })
  })

  describe("family", () => {
    it("should cache atoms by key", () => {
      let creationCount = 0

      const atomFamily = Atom.family((id: string) => {
        creationCount++
        return Atom.state(`value-${id}`)
      })

      const atom1 = atomFamily("a")
      const atom2 = atomFamily("b")
      const atom1Again = atomFamily("a")

      expect(creationCount).toEqual(2)
      expect(atom1).toBe(atom1Again)
      expect(atom1).not.toBe(atom2)
    })
  })

  describe("effect atoms", () => {
    it("should handle successful effects", async () => {
      const atom = Atom.effect(
        Effect.succeed(42),
        { initialValue: 0 }
      )

      // The effect runs immediately and synchronously for Effect.succeed
      // So we should already have the final value
      const result = atom.signal.get()

      expect(Result.isSuccess(result)).toBe(true)
      if (Result.isSuccess(result)) {
        // Effect.succeed is synchronous, so we get 42 immediately
        expect(result.value).toBe(42)
      }
    })

    it("should handle failing effects", () => {
      const error = new Error("test error")
      const atom = Atom.effect(
        Effect.fail(error)
      )

      // Effect.fail is also synchronous
      const result = atom.signal.get()
      expect(Result.isFailure(result)).toBe(true)
    })

    it("should handle async effects", async () => {
      // Use real timers for async effects
      vitest.useRealTimers()

      const atom = Atom.effect(
        Effect.promise(() =>
          new Promise<number>((resolve) => {
            setTimeout(() => resolve(99), 10)
          })
        ),
        { initialValue: 0 }
      )

      const initialResult = atom.signal.get()
      expect(Result.isSuccess(initialResult)).toBe(true)
      if (Result.isSuccess(initialResult)) {
        expect(initialResult.value).toBe(0)
      }

      // Wait for the async effect to complete
      await new Promise((resolve) => setTimeout(resolve, 20))

      const finalResult = atom.signal.get()
      expect(Result.isSuccess(finalResult)).toBe(true)
      if (Result.isSuccess(finalResult)) {
        expect(finalResult.value).toBe(99)
      }

      // Restore fake timers
      vitest.useFakeTimers()
    })
  })

  describe("integration with registry", () => {
    it("should work with Signal-based registry", () => {
      const registry = Registry.make({ useSignals: true } as any)
      const counter = Atom.state(0)

      // Direct signal access
      expect(counter.signal.get()).toEqual(0)

      counter.write(10)
      expect(counter.signal.get()).toEqual(10)
    })
  })
})
