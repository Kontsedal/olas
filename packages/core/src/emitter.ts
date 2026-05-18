/**
 * Synchronous fan-out event bus. Handlers run in the order they subscribed.
 * Handlers added during emit don't fire for the current emission; handlers
 * removed during emit are skipped from that point in the iteration.
 *
 * `Emitter<void>` exposes `emit()` (no argument); other shapes expose
 * `emit(value: T)`.
 *
 * Spec §7, §20.6.
 */
export type Emitter<T> = {
  emit: [T] extends [void] ? () => void : (value: T) => void
  /** Subscribe to every emission. Returns the unsubscribe function. */
  on(handler: (value: T) => void): () => void
  /** Subscribe to the next emission only. Auto-unsubscribes after firing. */
  once(handler: (value: T) => void): () => void
  /** Tear down the emitter. Subsequent `emit` / `on` / `once` are no-ops. */
  dispose(): void
}

type AnyHandler = (value: unknown) => void

class EmitterImpl<T> {
  private handlers = new Set<AnyHandler>()
  private disposed = false

  emit(value: T): void {
    if (this.disposed) return
    // Snapshot so a handler that unsubscribes itself (or another) doesn't
    // mutate the set mid-iteration.
    const snapshot = Array.from(this.handlers)
    for (const handler of snapshot) {
      handler(value as unknown)
    }
  }

  on(handler: (value: T) => void): () => void {
    if (this.disposed) return () => {}
    const wrapped = handler as AnyHandler
    this.handlers.add(wrapped)
    return () => {
      this.handlers.delete(wrapped)
    }
  }

  once(handler: (value: T) => void): () => void {
    if (this.disposed) return () => {}
    const wrapped: AnyHandler = (value) => {
      this.handlers.delete(wrapped)
      handler(value as T)
    }
    this.handlers.add(wrapped)
    return () => {
      this.handlers.delete(wrapped)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.handlers.clear()
  }
}

/**
 * Create a standalone emitter. Handlers persist until explicitly unsubscribed
 * (or the emitter is disposed). Use this for emitters that live outside any
 * single controller — typically in deps. Use `ctx.emitter()` for emitters that
 * should auto-clean with a controller.
 */
export function createEmitter<T = void>(): Emitter<T> {
  const impl = new EmitterImpl<T>()
  return {
    emit: ((value?: T) => impl.emit(value as T)) as Emitter<T>['emit'],
    on: (handler) => impl.on(handler),
    once: (handler) => impl.once(handler),
    dispose: () => impl.dispose(),
  }
}
