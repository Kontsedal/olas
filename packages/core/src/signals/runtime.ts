import {
  type ReadonlySignal as PreactReadonlySignal,
  type Signal as PreactSignal,
  batch as _batch,
  computed as _computed,
  effect as _effect,
  signal as _signal,
  untracked as _untracked,
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

export function signal<T>(initial: T): Signal<T> {
  return new SignalImpl(initial)
}

export function computed<T>(fn: () => T): Computed<T> {
  return new ComputedImpl(fn)
}

export function effect(fn: () => void | (() => void)): () => void {
  return _effect(fn)
}

export function batch<T>(fn: () => T): T {
  return _batch(fn)
}

export function untracked<T>(fn: () => T): T {
  return _untracked(fn)
}
