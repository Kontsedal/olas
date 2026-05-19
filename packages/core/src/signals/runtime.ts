import {
  batch as _batch,
  computed as _computed,
  effect as _effect,
  signal as _signal,
  untracked as _untracked,
  type ReadonlySignal as PreactReadonlySignal,
  type Signal as PreactSignal,
} from '@preact/signals-core'

import type { Computed, Signal } from './types'

class SignalImpl<T> implements Signal<T> {
  private readonly inner: PreactSignal<T>

  constructor(initial: T) {
    this.inner = _signal<T>(initial)
  }

  get value(): T {
    return this.inner.value
  }

  set value(next: T) {
    this.inner.value = next
  }

  peek(): T {
    return this.inner.peek()
  }

  subscribe(handler: (value: T) => void): () => void {
    return this.inner.subscribe(handler)
  }

  set(value: T): void {
    this.inner.value = value
  }

  update(fn: (prev: T) => T): void {
    this.inner.value = fn(this.inner.peek())
  }
}

class ComputedImpl<T> implements Computed<T> {
  private readonly inner: PreactReadonlySignal<T>

  constructor(fn: () => T) {
    this.inner = _computed<T>(fn)
  }

  get value(): T {
    return this.inner.value
  }

  peek(): T {
    return this.inner.peek()
  }

  subscribe(handler: (value: T) => void): () => void {
    return this.inner.subscribe(handler)
  }
}

/**
 * Create a writable `Signal<T>`. Reads track the current auto-tracking scope
 * (effect / computed); writes notify all subscribers (deduped via `Object.is`).
 *
 * Spec §20.1. For a single-pass non-tracked read use `signal.peek()`.
 */
export function signal<T>(initial: T): Signal<T> {
  return new SignalImpl(initial)
}

/**
 * Create a `Computed<T>` — a read-only derived signal. The provided `fn` is
 * re-evaluated whenever a signal it read during its last run changes; the
 * resulting value is cached until then.
 *
 * Spec §20.1. The graph is glitch-free: a `computed` re-runs at most once per
 * batched-write cycle.
 */
export function computed<T>(fn: () => T): Computed<T> {
  return new ComputedImpl(fn)
}

/**
 * Run `fn` immediately and again whenever any signal it reads changes. If
 * `fn` returns a function, that function is called as a cleanup before the
 * next re-run and on dispose.
 *
 * Returns a `dispose` function. Inside a controller use `ctx.effect(...)`
 * instead — that variant is auto-disposed with the controller.
 */
export function effect(fn: () => void | (() => void)): () => void {
  return _effect(fn)
}

/**
 * Batch synchronous signal writes so subscribers see one notification at the
 * end of the batch rather than one per write. Returns whatever `fn` returns.
 */
export function batch<T>(fn: () => T): T {
  return _batch(fn)
}

/**
 * Run `fn` with auto-tracking suppressed — signals read inside don't become
 * dependencies of the surrounding `computed` / `effect`. Useful for "read
 * these signals once to log them" or for snapshotting state inside an effect
 * without subscribing to it. For a single-signal peek, prefer `signal.peek()`.
 */
export function untracked<T>(fn: () => T): T {
  return _untracked(fn)
}
