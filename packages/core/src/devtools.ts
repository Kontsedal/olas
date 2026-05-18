export type DebugEvent =
  | { type: 'controller:constructed'; path: readonly string[]; props: unknown }
  | { type: 'controller:suspended'; path: readonly string[] }
  | { type: 'controller:resumed'; path: readonly string[] }
  | { type: 'controller:disposed'; path: readonly string[] }
  | {
      type: 'cache:subscribed'
      queryKey: readonly unknown[]
      subscriberPath: readonly string[]
    }
  | { type: 'cache:fetch-start'; queryKey: readonly unknown[] }
  | { type: 'cache:fetch-success'; queryKey: readonly unknown[]; durationMs: number }
  | {
      type: 'cache:fetch-error'
      queryKey: readonly unknown[]
      error: unknown
      durationMs: number
    }
  | { type: 'cache:invalidated'; queryKey: readonly unknown[] }
  | { type: 'cache:gc'; queryKey: readonly unknown[] }
  | { type: 'mutation:run'; path: readonly string[]; vars: unknown }
  | { type: 'mutation:success'; path: readonly string[]; result: unknown }
  | { type: 'mutation:error'; path: readonly string[]; error: unknown }
  | { type: 'mutation:rollback'; path: readonly string[] }
  | {
      type: 'field:validated'
      path: readonly string[]
      field: string
      valid: boolean
      errors: string[]
    }

export type DebugBus = {
  subscribe(handler: (event: DebugEvent) => void): () => void
}

/**
 * Per-root devtools event multiplexer. Emit is a no-op when no one is
 * subscribed (one Set size check), so leaving the bus in production has
 * effectively zero cost until a consumer attaches.
 *
 * Internal — exposed to consumers via `root.__debug`.
 */
export class DevtoolsEmitter implements DebugBus {
  private handlers = new Set<(event: DebugEvent) => void>()

  subscribe(handler: (event: DebugEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(event: DebugEvent): void {
    if (this.handlers.size === 0) return
    // Snapshot — handlers may unsubscribe.
    const snapshot = Array.from(this.handlers)
    for (const handler of snapshot) {
      try {
        handler(event)
      } catch {
        // Devtools handlers must not break the program.
      }
    }
  }

  get hasSubscribers(): boolean {
    return this.handlers.size > 0
  }
}
