/**
 * Signal-based effect implementation
 * This module provides an effect implementation using the Signal polyfill's Watcher API
 */

import { Signal } from "signal-polyfill"

/**
 * Simple effect implementation using Signal.subtle.Watcher
 * This handles automatic dependency tracking and re-execution
 */
export function createEffect(callback: () => void | (() => void), options?: {
  immediate?: boolean
}): () => void {
  let cleanup: (() => void) | void
  let needsEnqueue = true
  let isFirstRun = true

  const watcher = new Signal.subtle.Watcher(() => {
    if (needsEnqueue) {
      needsEnqueue = false
      queueMicrotask(processPending)
    }
  })

  function processPending() {
    needsEnqueue = true

    // Get all pending (dirty) signals
    for (const signal of watcher.getPending()) {
      // Force re-computation by reading the signal
      signal.get()
    }

    // Re-watch to continue tracking
    watcher.watch()
  }

  // Create a computed signal to track dependencies
  const computed = new Signal.Computed(() => {
    // Skip first run if not immediate
    if (isFirstRun && !options?.immediate) {
      isFirstRun = false
      return
    }

    // Clean up previous effect
    if (typeof cleanup === "function") {
      cleanup()
    }

    // Run the effect callback and capture cleanup function
    cleanup = callback()
  })

  // Start watching the computed signal
  watcher.watch(computed)

  // Initial execution to establish dependencies
  computed.get()
  isFirstRun = false

  // Return disposal function
  return () => {
    watcher.unwatch(computed)
    if (typeof cleanup === "function") {
      cleanup()
    }
    cleanup = undefined
  }
}

/**
 * Batch multiple signal updates
 * Signal updates are already batched automatically, but this provides
 * an explicit batching mechanism for compatibility
 */
export function batch(fn: () => void): void {
  // The Signal polyfill handles batching internally
  // We can directly execute the function
  fn()
}

/**
 * Create a simple scheduler for async effects
 * This is used to coordinate async operations with the Signal system
 */
export class EffectScheduler {
  private readonly watcher: Signal.subtle.Watcher
  private needsEnqueue = true
  private readonly effects = new Set<() => void>()

  constructor() {
    this.watcher = new Signal.subtle.Watcher(() => {
      if (this.needsEnqueue) {
        this.needsEnqueue = false
        queueMicrotask(() => this.processPending())
      }
    })
  }

  processPending(): void {
    this.needsEnqueue = true

    // Process all pending signals
    for (const signal of this.watcher.getPending()) {
      signal.get()
    }

    // Execute all scheduled effects
    const effects = Array.from(this.effects)
    this.effects.clear()

    for (const effect of effects) {
      effect()
    }

    // Re-watch
    this.watcher.watch()
  }

  scheduleEffect(effect: () => void): void {
    this.effects.add(effect)
    if (this.needsEnqueue) {
      this.needsEnqueue = false
      queueMicrotask(() => this.processPending())
    }
  }

  watch<T>(signal: Signal.Computed<T>): void {
    this.watcher.watch(signal)
  }

  unwatch<T>(signal: Signal.Computed<T>): void {
    this.watcher.unwatch(signal)
  }

  dispose(): void {
    this.effects.clear()
  }
}

/**
 * Global effect scheduler instance
 */
export const globalScheduler = new EffectScheduler()
