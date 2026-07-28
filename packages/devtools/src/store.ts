import type { DebugCacheEntry, DebugEvent, Root } from '@kontsedal/olas-core'
import { type Signal, signal } from '@kontsedal/olas-core'

/**
 * Per-path node in the live controller tree. `state` reflects the most
 * recently observed lifecycle event; `path` is the array reported by the
 * devtools bus.
 */
export type ControllerNode = {
  readonly path: readonly string[]
  state: 'active' | 'suspended' | 'disposed'
  props: unknown
  children: ControllerNode[]
}

/** One entry in the cache timeline. */
export type CacheEntry =
  | {
      id: number
      t: number
      kind: 'subscribed'
      queryKey: readonly unknown[]
      subscriberPath: readonly string[]
    }
  | { id: number; t: number; kind: 'fetch-start'; queryKey: readonly unknown[] }
  | {
      id: number
      t: number
      kind: 'fetch-success'
      queryKey: readonly unknown[]
      durationMs: number
    }
  | {
      id: number
      t: number
      kind: 'fetch-error'
      queryKey: readonly unknown[]
      durationMs: number
      error: unknown
    }
  | { id: number; t: number; kind: 'invalidated'; queryKey: readonly unknown[] }
  | { id: number; t: number; kind: 'gc'; queryKey: readonly unknown[] }

/** One entry in the mutation log. `durationMs` is set on success/error when
 * the entry can be paired with a preceding `run` for the same path+name. */
export type MutationEntry =
  | { id: number; t: number; kind: 'run'; path: readonly string[]; name?: string; vars: unknown }
  | {
      id: number
      t: number
      kind: 'success'
      path: readonly string[]
      name?: string
      result: unknown
      durationMs?: number
    }
  | {
      id: number
      t: number
      kind: 'error'
      path: readonly string[]
      name?: string
      error: unknown
      durationMs?: number
    }
  | { id: number; t: number; kind: 'rollback'; path: readonly string[]; name?: string }

/** One entry in the field validation log. */
export type FieldEntry = {
  id: number
  t: number
  path: readonly string[]
  field: string
  valid: boolean
  errors: string[]
}

/**
 * One entry in the unified causal timeline — a normalized view over EVERY
 * `DebugEvent`, ordered by `seq`. The panel groups these by `causeId` into
 * collapsible cause-chains and renders a structural before/after diff for
 * `cache:set-data`.
 */
export type TimelineEvent = {
  /** Store-assigned, stable for the entry's lifetime — the React key. */
  id: number
  /** Emitter sequence (or a store-assigned fallback for un-stamped events). */
  seq: number
  /** Epoch ms. */
  t: number
  /** Correlates events from one cause (mutation run / fetch) into a group. */
  causeId?: string
  /** The raw event — the panel derives badge / target / payload from it. */
  event: DebugEvent
  /**
   * For `cache:set-data` only: the entry's value *before* this write, captured
   * at ingest so the panel renders a before/after diff without re-deriving
   * history. Absent for the first write to a key (and all non-set-data events).
   */
  prev?: unknown
}

/** Defaults — exported so callers can override via `new DevtoolsStore({ maxEntries: 500 })`. */
export const DEFAULT_MAX_ENTRIES = 100

/**
 * Cap on the unified timeline (`events$`). Higher than the per-view log cap
 * because the timeline aggregates *every* event. Bounded rather than
 * virtualized (windowed rendering is a later phase), so kept modest.
 */
export const DEFAULT_MAX_TIMELINE_ENTRIES = 500

/**
 * Cap on disposed controller nodes retained in the tree. Beyond this, the
 * oldest fully-disposed subtrees are pruned so a long session with churny
 * controllers (virtualized lists, lazy children) doesn't grow the tree
 * unbounded. Active/suspended nodes are never pruned.
 */
export const DEFAULT_MAX_DISPOSED_NODES = 200

export type DevtoolsStoreOptions = {
  /** Cap on each event log (cache, mutation, field). Oldest entries drop first. */
  maxEntries?: number
  /** Cap on the unified timeline (`events$`). Oldest entries drop first. Default 500. */
  maxTimelineEntries?: number
  /** Cap on retained disposed controller nodes. Oldest disposed subtrees drop first. */
  maxDisposedNodes?: number
  /** Optional clock — useful for tests. Default: `() => Date.now()`. */
  now?: () => number
  /**
   * Event-write coalescing strategy.
   *
   * - `'sync'` (default) — each event writes its signal immediately. Best
   *   for low-volume apps and tests; produces one React render per event.
   * - `'raf'` — buffer writes and flush once per `requestAnimationFrame`.
   *   Best for high-volume apps (chat, live logs, infinite scroll mut
   *   storms). Reduces N rAF-bounded re-renders to 1.
   * - A `(fn) => handle` function — custom scheduler. Pair with
   *   `cancelSchedule`. Useful for tests that want explicit control via
   *   a deterministic queue.
   *
   * The default is `'sync'` because devtools panels are typically
   * driven by hand-curated test scenarios; opt into `'raf'` when wiring
   * the production `<DevtoolsPanel>`.
   */
  coalesce?: 'sync' | 'raf' | ((fn: () => void) => number)
  /** Cancel a scheduled flush — only needed when `coalesce` is a function. */
  cancelSchedule?: (handle: number) => void
}

/**
 * Subscribes to a root's `__debug` bus and maintains live state for the
 * devtools panel. Exposes signals so the React layer can consume via
 * `@kontsedal/olas-react`'s `use()`.
 *
 * Pure logic — no DOM, no React. Construct one per root.
 */
export class DevtoolsStore {
  readonly tree$: Signal<ControllerNode> = signal(makeRoot())
  readonly cache$: Signal<CacheEntry[]> = signal([])
  readonly mutations$: Signal<MutationEntry[]> = signal([])
  readonly fields$: Signal<FieldEntry[]> = signal([])
  /** Unified causal timeline — every event, ordered by seq. Bounded. */
  readonly events$: Signal<TimelineEvent[]> = signal([])
  /**
   * Live cache-entry state for the inspector. Seeded from
   * `root.__debug.queryEntries()` on `attach()`, then refreshed (coalesced) on
   * every cache / snapshot event — NO polling. Empty until attached.
   */
  readonly cacheState$: Signal<DebugCacheEntry[]> = signal([])

  private readonly maxEntries: number
  private readonly maxTimelineEntries: number
  private readonly maxDisposedNodes: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void) => number
  private readonly cancelSchedule: (handle: number) => void
  private nextId = 1
  /**
   * Store-assigned fallback sequence for events arriving without `seq` (bare
   * `handle()` calls in tests). Real root events are pre-stamped by the emitter.
   */
  private timelineSeq = 0
  /** Last-seen data per query-key hash — the baseline for the next set-data diff. */
  private lastDataByKey = new Map<string, unknown>()
  /** Source of the live cache snapshot, captured on `attach()`. */
  private queryEntries: (() => DebugCacheEntry[]) | undefined
  /**
   * Set when a cache / snapshot event arrives; drives a coalesced
   * `cacheState$` refresh in `flushPending` (replaces the old 800ms poll).
   */
  private cacheStateDirty = false

  /** Keyed by `path#name` → a FIFO queue of `run` start times. Overlapping
   *  runs of the same mutation each pair with their own start (shifted on
   *  settle); the key is deleted when its queue empties. A single-value map
   *  used to let a later run clobber an earlier run's start (T6.3). */
  private mutationStarts = new Map<string, number[]>()

  /**
   * Coalesce buffers — events arrive synchronously off the bus but
   * commits to the signals happen at most once per frame, so the React
   * panel re-renders at a sane rate even under 1000 evt/sec bursts.
   */
  private pendingCache: CacheEntry[] = []
  private pendingMutations: MutationEntry[] = []
  private pendingFields: FieldEntry[] = []
  private pendingTimeline: TimelineEvent[] = []
  private flushHandle: number | null = null

  /**
   * When `true`, incoming events are DROPPED at the store boundary —
   * unlike the panel-side pause which only hides them. Useful for
   * profiling without skewing recorded timings and for "freeze the log
   * so I can read it" UX.
   */
  private paused = false

  constructor(options?: DevtoolsStoreOptions) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxTimelineEntries = options?.maxTimelineEntries ?? DEFAULT_MAX_TIMELINE_ENTRIES
    this.maxDisposedNodes = options?.maxDisposedNodes ?? DEFAULT_MAX_DISPOSED_NODES
    this.now = options?.now ?? (() => Date.now())
    const coalesce = options?.coalesce ?? 'sync'
    if (coalesce === 'sync') {
      // Run the flush callback inline. The handle is irrelevant — we
      // never need to cancel a same-tick flush.
      this.schedule = (fn) => {
        fn()
        return 0
      }
      this.cancelSchedule = () => {}
    } else if (coalesce === 'raf') {
      // Wrap in arrows rather than assigning `requestAnimationFrame` directly:
      // called as a method (`this.schedule(fn)`) an unbound native rAF runs
      // with `this === store`, which real browsers reject with "Illegal
      // invocation". Calling it bare here keeps the global `this`. (jsdom's rAF
      // ignores `this`, so tests never caught this — only a real browser does.)
      this.schedule =
        typeof requestAnimationFrame === 'function'
          ? (fn: () => void) => requestAnimationFrame(fn)
          : (fn: () => void) => setTimeout(fn, 0) as unknown as number
      this.cancelSchedule =
        typeof cancelAnimationFrame === 'function'
          ? (h: number) => cancelAnimationFrame(h)
          : (h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)
    } else {
      this.schedule = coalesce
      this.cancelSchedule = options?.cancelSchedule ?? (() => {})
    }
  }

  /** Pause event ingestion. Recorded state is preserved; new events drop. */
  pause(): void {
    this.paused = true
  }

  /** Resume event ingestion. Buffered events from before pause are NOT replayed. */
  resume(): void {
    this.paused = false
    // `cacheState$` is the current world, not a log — cache events during the
    // pause were dropped before they could mark it dirty, so force it back in
    // sync now (no-op before `attach()`).
    this.refreshCacheState()
  }

  /** Whether ingestion is currently paused. */
  isPaused(): boolean {
    return this.paused
  }

  /**
   * Subscribe to the given root's debug bus. Returns the unsubscribe. The
   * caller (typically the React component) is responsible for invoking it
   * on unmount.
   */
  attach(root: Pick<Root<unknown>, '__debug'>): () => void {
    const unsub = root.__debug.subscribe((event) => this.handle(event))
    // Seed the live cache snapshot ONCE (no interval); it's refreshed from
    // events thereafter — see `refreshCacheState`. This is what lets the
    // inspector be event-driven instead of polling every 800ms.
    this.queryEntries = () => root.__debug.queryEntries()
    this.refreshCacheState()
    // Seed the per-key diff baseline from current live data too, so the first
    // post-attach write to an ALREADY-cached key diffs against its real value
    // rather than reading as an "initial" write (the fetch that populated it
    // happened before we subscribed).
    for (const e of this.cacheState$.peek()) {
      this.lastDataByKey.set(keyHash(e.key), e.data)
    }
    return unsub
  }

  /** Apply one event. Exposed for tests. */
  handle(event: DebugEvent): void {
    // Every event lands on the unified timeline (ordered by seq), regardless of
    // which specialized view (tree / cache / mutations / fields) it also feeds.
    this.pushTimeline(event)
    switch (event.type) {
      case 'controller:constructed':
        this.tree$.set(insertNode(this.tree$.peek(), event.path, event.props))
        return
      case 'controller:suspended':
        this.tree$.set(setNodeState(this.tree$.peek(), event.path, 'suspended'))
        return
      case 'controller:resumed':
        this.tree$.set(setNodeState(this.tree$.peek(), event.path, 'active'))
        return
      case 'controller:disposed':
        this.tree$.set(setNodeState(this.tree$.peek(), event.path, 'disposed'))
        // A controller that disposed mid-mutation (before `success`/`error`
        // ever fired) would otherwise leave its `mutation:run` start entry
        // in `mutationStarts` forever. Drop any starts under this path.
        this.dropStartsForPath(event.path)
        // Bound the tree — prune the oldest fully-disposed subtrees once the
        // retained-disposed count exceeds the cap (T6.3).
        this.pruneDisposed()
        return
      case 'cache:subscribed':
        this.pushCache({
          kind: 'subscribed',
          queryKey: event.queryKey,
          subscriberPath: event.subscriberPath,
        })
        return
      case 'cache:fetch-start':
        this.pushCache({ kind: 'fetch-start', queryKey: event.queryKey })
        return
      case 'cache:fetch-success':
        this.pushCache({
          kind: 'fetch-success',
          queryKey: event.queryKey,
          durationMs: event.durationMs,
        })
        return
      case 'cache:fetch-error':
        this.pushCache({
          kind: 'fetch-error',
          queryKey: event.queryKey,
          durationMs: event.durationMs,
          error: event.error,
        })
        return
      case 'cache:invalidated':
        this.pushCache({ kind: 'invalidated', queryKey: event.queryKey })
        return
      case 'cache:gc':
        // The entry is gone — drop its diff baseline so a later re-fetch of the
        // same key renders as an initial write (not a diff against a ghost
        // value), and so `lastDataByKey` stays bounded to live keys instead of
        // growing one entry per distinct key ever seen.
        this.lastDataByKey.delete(keyHash(event.queryKey))
        this.pushCache({ kind: 'gc', queryKey: event.queryKey })
        return
      case 'mutation:run': {
        const key = mutationKey(event.path, event.name)
        const q = this.mutationStarts.get(key)
        if (q === undefined) this.mutationStarts.set(key, [this.now()])
        else q.push(this.now())
        this.pushMutation({ kind: 'run', path: event.path, name: event.name, vars: event.vars })
        return
      }
      case 'mutation:success': {
        const durationMs = this.consumeStart(event.path, event.name)
        this.pushMutation({
          kind: 'success',
          path: event.path,
          name: event.name,
          result: event.result,
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        return
      }
      case 'mutation:error': {
        const durationMs = this.consumeStart(event.path, event.name)
        this.pushMutation({
          kind: 'error',
          path: event.path,
          name: event.name,
          error: event.error,
          ...(durationMs !== undefined ? { durationMs } : {}),
        })
        return
      }
      case 'mutation:rollback':
        this.pushMutation({ kind: 'rollback', path: event.path, name: event.name })
        return
      case 'field:validated':
        this.pushField({
          path: event.path,
          field: event.field,
          valid: event.valid,
          errors: event.errors,
        })
        return
    }
  }

  /**
   * Clear every log AND the unified timeline. Tree + live cache state are
   * preserved — they reflect the current world, not a history.
   */
  clearLogs(): void {
    this.cache$.set([])
    this.mutations$.set([])
    this.fields$.set([])
    this.events$.set([])
    // Drop pending coalesce buffers too — a scheduled flush after `clearLogs`
    // would otherwise revive entries the user just cleared.
    this.pendingCache = []
    this.pendingMutations = []
    this.pendingFields = []
    this.pendingTimeline = []
    // Reset the per-key diff baseline: after a clear, the next `cache:set-data`
    // starts a fresh before/after history rather than diffing against a value
    // whose originating event was just wiped.
    this.lastDataByKey.clear()
    if (this.flushHandle !== null) {
      this.cancelSchedule(this.flushHandle)
      this.flushHandle = null
    }
    // Drop pending mutation-start timing records too — `clearLogs()` is the
    // user's "start fresh" gesture; any subsequent `success`/`error` for a
    // pre-clear `run` would have produced a duration anchored to noise.
    this.mutationStarts.clear()
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Append an event to the unified timeline and (for cache / snapshot events)
   * mark the live cache snapshot dirty. Runs for EVERY event, before the
   * specialized routing in `handle`.
   */
  private pushTimeline(event: DebugEvent): void {
    if (this.paused) return
    if (event.type.startsWith('cache:') || event.type.startsWith('snapshot:')) {
      this.cacheStateDirty = true
    }
    const entry: TimelineEvent = {
      id: this.nextId++,
      // Prefer the emitter's `seq` (globally ordered); fall back to a store
      // counter for bare `handle()` calls (tests) that arrive un-stamped.
      seq: event.seq ?? ++this.timelineSeq,
      t: event.t ?? this.now(),
      event,
    }
    if (event.causeId !== undefined) entry.causeId = event.causeId
    if (event.type === 'cache:set-data') {
      const key = keyHash(event.queryKey)
      // Capture the pre-write value for the diff, then advance the baseline.
      if (this.lastDataByKey.has(key)) entry.prev = this.lastDataByKey.get(key)
      this.lastDataByKey.set(key, event.data)
    }
    this.pendingTimeline.push(entry)
    this.scheduleFlush()
  }

  /**
   * Re-read the live cache snapshot from the root. Called once on `attach()`
   * (seed) and again — coalesced via `flushPending` — whenever a cache /
   * snapshot event arrives. No-op before `attach()` (bare-store tests).
   */
  private refreshCacheState(): void {
    if (this.queryEntries === undefined) return
    this.cacheState$.set(this.queryEntries())
    this.cacheStateDirty = false
  }

  private pushCache(entry: DistributiveOmit<CacheEntry, 'id' | 't'>): void {
    if (this.paused) return
    const full = { id: this.nextId++, t: this.now(), ...entry } as CacheEntry
    this.pendingCache.push(full)
    this.scheduleFlush()
  }

  private pushMutation(entry: DistributiveOmit<MutationEntry, 'id' | 't'>): void {
    if (this.paused) return
    const full = { id: this.nextId++, t: this.now(), ...entry } as MutationEntry
    this.pendingMutations.push(full)
    this.scheduleFlush()
  }

  private pushField(entry: Omit<FieldEntry, 'id' | 't'>): void {
    if (this.paused) return
    const full = { id: this.nextId++, t: this.now(), ...entry } as FieldEntry
    this.pendingFields.push(full)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return
    // Sentinel value placed *before* `schedule` runs so a synchronous
    // scheduler doesn't see `null` AND we don't overwrite the `null` the
    // callback sets after a sync flush completes.
    this.flushHandle = -1
    const handle = this.schedule(() => {
      this.flushHandle = null
      this.flushPending()
    })
    // Only adopt the real handle if the sync flush hasn't already cleared
    // it. Otherwise the sentinel write above + sync clear inside the
    // callback would race with this assignment.
    if (this.flushHandle === -1) {
      this.flushHandle = handle === 0 ? null : handle
    }
  }

  /**
   * Drain pending buffers into the signals. Public so tests can force a
   * flush without waiting on rAF; production code shouldn't call this.
   */
  flushPending(): void {
    if (this.pendingCache.length > 0) {
      let next = this.cache$.peek().slice()
      for (const e of this.pendingCache) next.push(e)
      if (next.length > this.maxEntries) next = next.slice(next.length - this.maxEntries)
      this.pendingCache = []
      this.cache$.set(next)
    }
    if (this.pendingMutations.length > 0) {
      let next = this.mutations$.peek().slice()
      for (const e of this.pendingMutations) next.push(e)
      if (next.length > this.maxEntries) next = next.slice(next.length - this.maxEntries)
      this.pendingMutations = []
      this.mutations$.set(next)
    }
    if (this.pendingFields.length > 0) {
      let next = this.fields$.peek().slice()
      for (const e of this.pendingFields) next.push(e)
      if (next.length > this.maxEntries) next = next.slice(next.length - this.maxEntries)
      this.pendingFields = []
      this.fields$.set(next)
    }
    if (this.pendingTimeline.length > 0) {
      let next = this.events$.peek().slice()
      for (const e of this.pendingTimeline) next.push(e)
      if (next.length > this.maxTimelineEntries) {
        next = next.slice(next.length - this.maxTimelineEntries)
      }
      this.pendingTimeline = []
      this.events$.set(next)
    }
    // Coalesced inspector refresh — one snapshot read per frame no matter how
    // many cache events landed, and only when something actually changed.
    if (this.cacheStateDirty) this.refreshCacheState()
  }

  private consumeStart(path: readonly string[], name: string | undefined): number | undefined {
    const key = mutationKey(path, name)
    const q = this.mutationStarts.get(key)
    if (q === undefined || q.length === 0) return undefined
    // FIFO: pair this settle with the OLDEST pending start so overlapping runs
    // of the same mutation each get a duration (T6.3). Exact run↔settle
    // attribution isn't possible — the debug bus carries no per-run id — but
    // FIFO never loses a start the way the old single-value map did.
    const startedAt = q.shift() as number
    if (q.length === 0) this.mutationStarts.delete(key)
    return this.now() - startedAt
  }

  /**
   * Drop every pending mutation-start record under `path` (and its
   * descendants). Called on `controller:disposed` so a dispose mid-mutation
   * doesn't leave a permanent entry in `mutationStarts`.
   */
  private dropStartsForPath(path: readonly string[]): void {
    if (this.mutationStarts.size === 0) return
    const prefix = `${path.join('>')}>`
    const exact = path.join('>')
    for (const key of this.mutationStarts.keys()) {
      const beforeHash = key.split('#')[0] ?? ''
      if (beforeHash === exact || beforeHash.startsWith(prefix)) {
        this.mutationStarts.delete(key)
      }
    }
  }

  /**
   * Remove the oldest fully-disposed subtrees once the retained-disposed count
   * exceeds `maxDisposedNodes`. "Fully-disposed subtree" = a node whose entire
   * subtree is disposed, so an active/suspended node (or one with a live
   * descendant) is never pruned. Roots are collected in depth-first
   * (construction) order, so the earliest-constructed disposed subtrees drop
   * first (T6.3).
   */
  private pruneDisposed(): void {
    const tree = this.tree$.peek()
    let remaining = countDisposed(tree)
    if (remaining <= this.maxDisposedNodes) return
    const roots: { path: readonly string[]; size: number }[] = []
    collectPrunableRoots(tree, roots)
    let next = tree
    for (const r of roots) {
      if (remaining <= this.maxDisposedNodes) break
      next = removeNodeAt(next, r.path)
      remaining -= r.size
    }
    if (next !== tree) this.tree$.set(next)
  }
}

function mutationKey(path: readonly string[], name: string | undefined): string {
  return `${path.join('>')}#${name ?? ''}`
}

/**
 * Stable string key for a query-key array — tracks the last-seen data per entry
 * so the timeline can diff a `cache:set-data` against the prior value.
 * `JSON.stringify` covers the common primitive-array case; a `String` join is
 * the fallback for keys carrying unserializable members.
 */
function keyHash(key: readonly unknown[]): string {
  try {
    // Distinguish `undefined` from `null` (both otherwise serialize to `null`)
    // and stringify BigInt (`JSON.stringify` throws on it), so two distinct
    // keys can't collide onto one diff-baseline slot. Tagged with a shape
    // unlikely to occur as a real key value.
    return JSON.stringify(key, (_k, v) => {
      if (v === undefined) return { __olasKey: 'undefined' }
      if (typeof v === 'bigint') return { __olasKey: 'bigint', v: v.toString() }
      return v
    })
  } catch {
    // Last resort for genuinely unserializable keys (circular refs). Type-tag
    // each member so the join can't alias e.g. `['a','b']` and `['a|b']`.
    return key.map((k) => `${typeof k}:${String(k)}`).join('|')
  }
}

/**
 * Distributes `Omit` over a discriminated union so each variant keeps its own
 * keys. The default `Omit<A | B, K>` collapses to the intersection of keys —
 * not what we want when constructing one variant at a time.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// ---------------------------------------------------------------------------
// Pure helpers — tested independently of the class.
// ---------------------------------------------------------------------------

function makeRoot(): ControllerNode {
  return { path: [], state: 'active', props: undefined, children: [] }
}

/**
 * Insert (or update) a node at `path` inside the tree. Auto-creates any
 * missing intermediate ancestors as 'active' placeholders — needed if the
 * subscriber attached after the root was constructed.
 *
 * Returns a NEW tree object (immutable update).
 */
export function insertNode(
  root: ControllerNode,
  path: readonly string[],
  props: unknown,
): ControllerNode {
  if (path.length === 0) {
    // The root controller's "constructed" event has path === ['root']
    // (one segment), not []. We never receive empty paths in practice, but
    // handle defensively.
    return { ...root, state: 'active', props }
  }
  return cloneWithUpsert(root, path, 0, props)
}

function cloneWithUpsert(
  node: ControllerNode,
  path: readonly string[],
  depth: number,
  props: unknown,
): ControllerNode {
  if (depth === path.length) {
    return { ...node, state: 'active', props }
  }
  const segment = path[depth] as string
  // Match by both segment AND depth: matching only by last segment aliases
  // children whose paths happen to end in the same string but actually have
  // different depths or different prefixes (e.g. a controller renamed mid-
  // session, or a collection item whose path tail collides with an unrelated
  // sibling at a different level). Comparing depth + segment uniquely
  // identifies a direct child of this node.
  const idx = node.children.findIndex(
    (c) => c.path.length === depth + 1 && c.path[depth] === segment,
  )
  const childPath = path.slice(0, depth + 1)
  if (idx === -1) {
    const newChild = cloneWithUpsert(
      { path: childPath, state: 'active', props: undefined, children: [] },
      path,
      depth + 1,
      props,
    )
    return { ...node, children: [...node.children, newChild] }
  }
  const existing = node.children[idx]!
  const updatedChild = cloneWithUpsert(existing, path, depth + 1, props)
  const nextChildren = node.children.slice()
  nextChildren[idx] = updatedChild
  return { ...node, children: nextChildren }
}

/**
 * Set `state` on the node at `path`. If the node doesn't exist (out-of-order
 * event delivery), the tree is returned unchanged.
 */
export function setNodeState(
  root: ControllerNode,
  path: readonly string[],
  state: ControllerNode['state'],
): ControllerNode {
  if (path.length === 0) {
    return { ...root, state }
  }
  return setStateAt(root, path, 0, state) ?? root
}

function setStateAt(
  node: ControllerNode,
  path: readonly string[],
  depth: number,
  state: ControllerNode['state'],
): ControllerNode | null {
  if (depth === path.length) {
    return { ...node, state }
  }
  const segment = path[depth] as string
  // Same depth+segment match as `cloneWithUpsert`.
  const idx = node.children.findIndex(
    (c) => c.path.length === depth + 1 && c.path[depth] === segment,
  )
  if (idx === -1) return null
  const existing = node.children[idx]!
  const updatedChild = setStateAt(existing, path, depth + 1, state)
  if (updatedChild === null) return null
  const nextChildren = node.children.slice()
  nextChildren[idx] = updatedChild
  return { ...node, children: nextChildren }
}

/** Total disposed nodes in a subtree. */
function countDisposed(node: ControllerNode): number {
  let n = node.state === 'disposed' ? 1 : 0
  for (const c of node.children) n += countDisposed(c)
  return n
}

/** Total nodes in a subtree. */
function countNodes(node: ControllerNode): number {
  let n = 1
  for (const c of node.children) n += countNodes(c)
  return n
}

/** True iff `node` and every descendant is disposed. */
function subtreeAllDisposed(node: ControllerNode): boolean {
  return node.state === 'disposed' && node.children.every(subtreeAllDisposed)
}

/**
 * Collect the roots of maximal fully-disposed subtrees, in depth-first
 * (construction) order. A fully-disposed subtree is pruned as a unit, so we
 * don't descend into one once found — and an active/suspended ancestor is
 * never a root, protecting live nodes.
 */
function collectPrunableRoots(
  node: ControllerNode,
  out: { path: readonly string[]; size: number }[],
): void {
  if (subtreeAllDisposed(node)) {
    out.push({ path: node.path, size: countNodes(node) })
    return
  }
  for (const c of node.children) collectPrunableRoots(c, out)
}

/**
 * Remove the node at `path` (and its subtree) from the tree. Returns a NEW
 * tree object (immutable update); returns the input unchanged if the path
 * doesn't resolve or targets the virtual root (never removed).
 */
export function removeNodeAt(root: ControllerNode, path: readonly string[]): ControllerNode {
  if (path.length === 0) return root
  return removeAt(root, path, 0) ?? root
}

function removeAt(
  node: ControllerNode,
  path: readonly string[],
  depth: number,
): ControllerNode | null {
  const segment = path[depth] as string
  const idx = node.children.findIndex(
    (c) => c.path.length === depth + 1 && c.path[depth] === segment,
  )
  if (idx === -1) return null
  if (depth + 1 === path.length) {
    const nextChildren = node.children.slice()
    nextChildren.splice(idx, 1)
    return { ...node, children: nextChildren }
  }
  const updatedChild = removeAt(node.children[idx]!, path, depth + 1)
  if (updatedChild === null) return null
  const nextChildren = node.children.slice()
  nextChildren[idx] = updatedChild
  return { ...node, children: nextChildren }
}
