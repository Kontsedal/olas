/**
 * Read-only reactive value. Reading `.value` inside a tracking scope
 * (`computed` / `effect`) registers a dependency; `peek()` reads without
 * tracking; `subscribe(handler)` fires `handler` immediately with the current
 * value and on every change until the returned unsubscribe is called.
 */
export type ReadSignal<T> = {
  readonly value: T
  /** Read the current value without registering a dependency. */
  peek(): T
  /**
   * Subscribe to value changes. The handler is called synchronously with the
   * current value on subscribe and on every change thereafter. Returns the
   * unsubscribe function.
   */
  subscribe(handler: (value: T) => void): () => void
}

/**
 * Writable reactive value. `value` is assignable; `set(value)` is the
 * functional equivalent; `update(fn)` reads (peek) and writes the result of
 * `fn(previous)`.
 */
export type Signal<T> = ReadSignal<T> & {
  value: T
  set(value: T): void
  update(fn: (prev: T) => T): void
}

/** A read-only derived signal — alias of `ReadSignal<T>`. */
export type Computed<T> = ReadSignal<T>
