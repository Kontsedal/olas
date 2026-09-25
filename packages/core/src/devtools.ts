/**
 * Correlation fields stamped onto — or shared across — every {@link DebugEvent}.
 * All optional: consumers building events by hand (and the devtools store's
 * `handle()` in tests) need not supply them, and the emitter fills `seq`/`t`
 * in on the way out. Adding them is non-breaking.
 */
export type DebugEventMeta = {
  /**
   * Monotonic per-root sequence number, stamped by the root's devtools emitter.
   * Strictly increasing in delivery order — the canonical sort key for a
   * timeline, since wall-clock `t` can tie under a burst and is approximate
   * for events replayed to a late subscriber.
   */
  seq?: number
  /** Epoch ms when the event was emitted (or replayed). Stamped by the emitter. */
  t?: number
  /**
   * Correlates every event produced by one cause — a single mutation run, a
   * single fetch — into one collapsible group in the devtools timeline. A
   * mutation's run id flows into the optimistic `cache:set-data`, the
   * `snapshot:*` events, the `mutation:rollback`, and the mutation's own
   * lifecycle events; a fetch's id flows into its `cache:fetch-*` and the
   * `cache:set-data` it writes. Absent when core can't cheaply attribute a
   * cause (e.g. a bare `query.setData(...)` outside any mutation).
   */
  causeId?: string
}

/**
 * The set of event bodies emitted by a root. `DebugEvent` layers
 * {@link DebugEventMeta} onto each (see below). Spec §14. Adding new variants
 * is non-breaking — consumers `switch` on `type` and ignore unknowns.
 */
export type DebugEventBody =
  | {
      type: 'controller:constructed'
      path: readonly string[]
      props: unknown
      /**
       * Values registered via `ctx.debug({...})` during construction — live
       * references (signals stay reactive in the panel). Absent when none.
       */
      debug?: Record<string, unknown>
    }
  | { type: 'controller:suspended'; path: readonly string[] }
  | { type: 'controller:resumed'; path: readonly string[] }
  | { type: 'controller:disposed'; path: readonly string[] }
  /**
   * A `ctx.debug({...})` call AFTER construction (e.g. from an effect) —
   * carries the controller's full merged debug record (live references).
   */
  | { type: 'controller:debug'; path: readonly string[]; values: Record<string, unknown> }
  | {
      type: 'cache:subscribed'
      queryKey: readonly unknown[]
      subscriberPath: readonly string[]
    }
  | { type: 'cache:fetch-start'; queryId?: string; queryKey: readonly unknown[] }
  | {
      type: 'cache:fetch-success'
      queryId?: string
      queryKey: readonly unknown[]
      durationMs: number
    }
  | {
      type: 'cache:fetch-error'
      queryId?: string
      queryKey: readonly unknown[]
      error: unknown
      durationMs: number
    }
  /**
   * A value was written to a cache entry. `data` is the post-write value —
   * carried so the devtools cache inspector and timeline diff show *current*
   * data without polling. `source` is the plugins' `WriteSource` vocabulary:
   * `'fetch'`, `'hydrate'`, `'optimistic'`, `'rollback'`, `'write'`,
   * `'replace'`.
   */
  | {
      type: 'cache:set-data'
      queryId?: string
      queryKey: readonly unknown[]
      source: import('./plugin/types').WriteSource
      data: unknown
    }
  | { type: 'cache:invalidated'; queryId?: string; queryKey: readonly unknown[] }
  | { type: 'cache:gc'; queryId?: string; queryKey: readonly unknown[] }
  /** An optimistic snapshot layer was pushed onto an entry (`setData` with tracking). */
  | { type: 'snapshot:push'; queryKey: readonly unknown[] }
  /** An optimistic snapshot layer was rolled back (mutation error / supersede). */
  | { type: 'snapshot:rollback'; queryKey: readonly unknown[] }
  /** An optimistic snapshot layer was committed (mutation success). */
  | { type: 'snapshot:finalize'; queryKey: readonly unknown[] }
  /**
   * The mutation lifecycle. `id` is the mutation's `id`, absent for an inline
   * `createMutation` spec that has none.
   */
  | { type: 'mutation:run'; path: readonly string[]; id?: string; vars: unknown }
  | { type: 'mutation:success'; path: readonly string[]; id?: string; result: unknown }
  | { type: 'mutation:error'; path: readonly string[]; id?: string; error: unknown }
  | { type: 'mutation:rollback'; path: readonly string[]; id?: string }
  | {
      type: 'field:validated'
      path: readonly string[]
      field: string
      valid: boolean
      errors: string[]
    }
  /** A plugin published `payload` on its lane through `host.debug(...)`. */
  | { type: 'plugin:event'; plugin: string; payload: unknown }

/**
 * Distribute {@link DebugEventMeta} across every variant of the union. Written
 * as a distributive conditional (not a plain `DebugEventBody & DebugEventMeta`
 * intersection) so each member keeps its literal `type` discriminant and
 * `switch (event.type)` still narrows.
 */
export type DebugEvent = DebugEventBody extends infer B
  ? B extends DebugEventBody
    ? B & DebugEventMeta
    : never
  : never

/**
 * Snapshot of one live cache entry — produced by `root.debug.queryEntries()`
 * so devtools panels can show *current data*, not just past fetch events.
 */
export type DebugCacheEntry = {
  /** The query this entry belongs to. Two queries can hold entries under one key. */
  queryId: string
  key: readonly unknown[]
  status: 'idle' | 'pending' | 'success' | 'error'
  data: unknown
  error: unknown
  lastUpdatedAt: number | undefined
  isStale: boolean
  isFetching: boolean
  hasPendingMutations: boolean
}

/**
 * The shape of `root.debug`. Subscribe to receive every `DebugEvent` until
 * the returned unsubscribe is called.
 *
 * The bus replays a snapshot of the *live controller tree* to every new
 * subscriber synchronously inside `subscribe(...)` — so a panel that mounts
 * after `createRoot()` sees the existing tree immediately, not just future
 * events. Event types other than `controller:*` are not buffered.
 *
 * `queryEntries()` returns a fresh inspector snapshot — current state of
 * every cached entry. Useful for "what's in the cache right now?" views.
 */
export type DebugBus = {
  subscribe(handler: (event: DebugEvent) => void): () => void
  queryEntries(): DebugCacheEntry[]
}

type LiveControllerEntry = {
  path: readonly string[]
  props: unknown
  state: 'active' | 'suspended'
  /** Latest `ctx.debug({...})` record for this controller (live refs), if any. */
  debug?: Record<string, unknown>
}

function pathKey(path: readonly string[]): string {
  return path.join('\u0000')
}

/**
 * Per-root devtools event multiplexer. Emit is a no-op when no one is
 * subscribed (one Set size check), so leaving the bus in production has
 * effectively zero cost until a consumer attaches.
 *
 * Internal — exposed to consumers via `root.debug`.
 *
 * Tracks a snapshot of every live controller (constructed but not yet
 * disposed) and replays construction events to new subscribers, so the
 * devtools tree populates on mount instead of staying blank until the
 * next event.
 */
export class DevtoolsEmitter {
  private handlers = new Set<(event: DebugEvent) => void>()
  /** Path → entry for every live (constructed, not disposed) controller. */
  private liveControllers = new Map<string, LiveControllerEntry>()
  /**
   * Monotonic sequence stamped onto every delivered event — live emits and
   * replayed snapshot events alike — so a subscriber can order a timeline by
   * `seq` even when wall-clock `t` ties or a burst arrives in one tick.
   */
  private seq = 0

  subscribe(handler: (event: DebugEvent) => void): () => void {
    // Replay the snapshot of the current tree, in insertion order. Insertion
    // order matches construction order, which is parent-before-child (parents
    // construct their children inside their factories). The replayed handler
    // gets the same event shape it would have seen live, `seq`/`t`-stamped so
    // it sorts (before any subsequent live event) in the subscriber's timeline.
    for (const entry of this.liveControllers.values()) {
      try {
        handler(
          this.stamp({
            type: 'controller:constructed',
            path: entry.path,
            props: entry.props,
            ...(entry.debug !== undefined ? { debug: entry.debug } : {}),
          }),
        )
        if (entry.state === 'suspended') {
          handler(this.stamp({ type: 'controller:suspended', path: entry.path }))
        }
      } catch {
        // Devtools handlers must not break replay for other handlers.
      }
    }
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(event: DebugEvent): void {
    // Track live controllers regardless of subscriber count — the snapshot
    // must be accurate even when no one was watching. Uses the raw (unstamped)
    // event; it reads only `type`/`path`/`props`.
    this.recordLifecycle(event)
    if (this.handlers.size === 0) return
    const stamped = this.stamp(event)
    // Snapshot — handlers may unsubscribe.
    const snapshot = Array.from(this.handlers)
    for (const handler of snapshot) {
      try {
        handler(stamped)
      } catch {
        // Devtools handlers must not break the program.
      }
    }
  }

  /**
   * Return a copy of `event` stamped with a fresh `seq` and the current `t`.
   * A copy (not an in-place mutation) so the caller's inline event object
   * isn't surprised by extra fields. `seq`/`t` are always (re)assigned here —
   * the emitter owns them. A `causeId` is preserved only when present:
   * `causeId: undefined` (which some call sites pass unconditionally) is
   * dropped, so "no cause" is uniformly *absent* rather than sometimes
   * present-with-`undefined` — consumers can rely on `'causeId' in event`.
   */
  private stamp(event: DebugEvent): DebugEvent {
    const { causeId, ...rest } = event as DebugEvent & { causeId?: string }
    const base = { ...rest, seq: ++this.seq, t: Date.now() }
    return (causeId === undefined ? base : { ...base, causeId }) as DebugEvent
  }

  get hasSubscribers(): boolean {
    return this.handlers.size > 0
  }

  private recordLifecycle(event: DebugEvent): void {
    if (event.type === 'controller:constructed') {
      this.liveControllers.set(pathKey(event.path), {
        path: event.path,
        props: event.props,
        state: 'active',
        ...(event.debug !== undefined ? { debug: event.debug } : {}),
      })
      return
    }
    if (event.type === 'controller:debug') {
      // Post-construction ctx.debug(...) — update the live entry so a late
      // subscriber replays the current variables.
      const cur = this.liveControllers.get(pathKey(event.path))
      if (cur !== undefined) cur.debug = event.values
      return
    }
    if (event.type === 'controller:suspended') {
      const key = pathKey(event.path)
      const cur = this.liveControllers.get(key)
      if (cur !== undefined) cur.state = 'suspended'
      return
    }
    if (event.type === 'controller:resumed') {
      const key = pathKey(event.path)
      const cur = this.liveControllers.get(key)
      if (cur !== undefined) cur.state = 'active'
      return
    }
    if (event.type === 'controller:disposed') {
      this.liveControllers.delete(pathKey(event.path))
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Ambient cause context (dev-only)
// ---------------------------------------------------------------------------
//
// Threads a mutation run's `causeId` into the events its `onMutate` /
// rollback synchronously trigger — the optimistic `cache:set-data`, the
// `snapshot:*` layer events — WITHOUT changing `setData` / `Entry` signatures.
// A mutation wraps `onMutate` (and the snapshot rollback/finalize) in
// `__runWithCause(runId, ...)`; the QueryClient's devtools emit sites read
// `__currentCauseId()` at emit time and stamp it on. Synchronous by design:
// the correlated writes (`setData` inside `onMutate`, the rollback) all happen
// on the stack while the cause is active. Internal — not re-exported from the
// package index.

let currentCauseId: string | undefined

/**
 * Run `fn` with `causeId` installed as the ambient cause, restoring the prior
 * value afterward (nestable). A no-op passthrough outside dev builds, so it
 * costs nothing in production. Returns `fn`'s result.
 */
export function __runWithCause<T>(causeId: string, fn: () => T): T {
  if (!__DEV__) return fn()
  const prev = currentCauseId
  currentCauseId = causeId
  try {
    return fn()
  } finally {
    currentCauseId = prev
  }
}

/** The ambient cause id, if a `__runWithCause(...)` frame is active. Dev-only. */
export function __currentCauseId(): string | undefined {
  return __DEV__ ? currentCauseId : undefined
}
