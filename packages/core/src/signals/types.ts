export type ReadSignal<T> = {
  readonly value: T
  peek(): T
  subscribe(handler: (value: T) => void): () => void
}

export type Signal<T> = ReadSignal<T> & {
  value: T
  set(value: T): void
  update(fn: (prev: T) => T): void
}

export type Computed<T> = ReadSignal<T>
