import type { DebugCacheEntry, DebugEvent, ReadSignal, Root } from '@kontsedal/olas-core'
import { batch, computed, type Signal, signal } from '@kontsedal/olas-core'
import { type SearchGroup, SearchIndex, type SearchStats } from './search'
import { entryKey, isSignalLike, pathKey } from './util'

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
  /**
   * Values registered via `ctx.debug({...})` — live references the panel
   * renders reactively (signals show current values). Absent until the
   * controller registers any. On a disposed node they are frozen: each signal
   * was read once, at dispose time, and replaced by the value it held.
   */
  debug?: Record<string, unknown>
  /** Epoch ms of the `controller:disposed` that retired this node. Disposed nodes only. */
  disposedAt?: number
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
 * Capacity of the unified timeline's ring buffer (`events$`). The panel
 * renders it through a windowed list, so the bound is about memory, not DOM.
 * Past it the oldest event is overwritten and `droppedEvents$` counts it.
 */
export const DEFAULT_MAX_TIMELINE_ENTRIES = 10_000

/**
 * Cap on disposed controller nodes retained in the tree. Beyond this, the
 * earliest-disposed fully-disposed subtrees are pruned so a long session with
 * churny controllers (virtualized lists, lazy children) doesn't grow the tree
 * unbounded. Active and suspended nodes are never pruned.
 */
export const DEFAULT_MAX_DISPOSED_NODES = 200

export type DevtoolsStoreOptions = {
  /** Cap on each event log (cache, mutation, field). Oldest entries drop first. */
  maxEntries?: number
  /** Ring-buffer capacity of the unified timeline (`events$`). Default 10,000. */
  maxTimelineEntries?: number
  /** Cap on retained disposed controller nodes. Earliest-disposed subtrees drop first. */
  maxDisposedNodes?: number
  /** Optional clock — useful for tests. Default: `() => Date.now()`. */
  now?: () => number
  /**
   * Event-write coalescing strategy for the logs and the timeline. The tree
   * applies every lifecycle event at once, whatever this says.
   *
   * - `'sync'` (default) — each event writes its signal immediately. Best
   *   for low-volume apps and tests; produces one React render per event.
   * - `'raf'` — buffer writes and flush once per `requestAnimationFrame`.
   *   Best for high-volume apps (chat, live logs, infinite scroll mut
   *   storms). Reduces N rAF-bounded re-renders to 1.
   * - A `(fn) => handle` function — custom scheduler. Pair with
   *   `cancelSchedule`. Useful for tests that want explicit control via
   *   a deterministic queue.
   */
  coalesce?: 'sync' | 'raf' | ((fn: () => void) => number)
  /** Cancel a scheduled flush — only needed when `coalesce` is a function. */
  cancelSchedule?: (handle: number) => void
}

/**
 * A fixed-capacity log. `add` buffers an item; `flush` moves the buffer in,
 * overwriting the oldest item once full, and publishes a new array through
 * `view`. Both are O(1) per item. The array is built lazily, when `view` is
 * read, so a burst of flushes nobody reads costs nothing.
 */
class Ring<T> {
  private items: T[] = []
  private head = 0
  private pending: T[] = []
  private readonly capacity: number
  private readonly rev = signal(0)
  /** Items evicted by capacity since the last `clear`. */
  dropped = 0
  /** The items, oldest first. */
  readonly view: ReadSignal<T[]> = computed(() => {
    this.rev.value
    const { items, head } = this
    return head === 0 ? items.slice() : items.slice(head).concat(items.slice(0, head))
  })
  readonly dropped$: ReadSignal<number> = computed(() => {
    this.rev.value
    return this.dropped
  })

  constructor(capacity: number) {
    this.capacity = Math.max(0, Math.floor(capacity))
  }

  add(item: T): void {
    this.pending.push(item)
  }

  /** Returns whether anything moved in. */
  flush(): boolean {
    if (this.pending.length === 0) return false
    const cap = this.capacity
    for (const item of this.pending) {
      if (this.items.length < cap) {
        this.items.push(item)
        continue
      }
      this.dropped++
      if (cap === 0) continue
      this.items[this.head] = item
      this.head = (this.head + 1) % cap
    }
    this.pending = []
    this.rev.set(this.rev.peek() + 1)
    return true
  }

  clear(): void {
    this.items = []
    this.head = 0
    this.pending = []
    this.dropped = 0
    this.rev.set(this.rev.peek() + 1)
  }
}

/**
 * A live, mutable tree node. The store edits these in place — O(1) lookup by
 * path key, O(depth) bookkeeping — and hands the panel immutable
 * `ControllerNode` snapshots, rebuilt only along the paths that changed.
 */
type Cell = {
  readonly key: string
  readonly segment: string
  readonly path: readonly string[]
  readonly parent: Cell | null
  state: ControllerNode['state']
  props: unknown
  debug: Record<string, unknown> | undefined
  disposedAt: number | undefined
  /** By segment. A Map keeps insertion (construction) order and deletes in O(1). */
  readonly children: Map<string, Cell>
  /** Nodes in this subtree, itself included. */
  size: number
  /** Non-disposed nodes in this subtree, itself included. 0 = fully disposed. */
  live: number
  /** The cached snapshot; `null` once this node or a descendant changed. */
  snap: ControllerNode | null
  removed: boolean
  /** Stamp of this cell's latest dispose; matches its live queue entry. */
  disposeSeq: number
}

function makeCell(path: readonly string[], parent: Cell | null): Cell {
  return {
    key: pathKey(path),
    segment: path[path.length - 1] ?? '',
    path,
    parent,
    state: 'active',
    props: undefined,
    debug: undefined,
    disposedAt: undefined,
    children: new Map(),
    size: 1,
    live: 1,
    snap: null,
    removed: false,
    disposeSeq: 0,
  }
}

function snapshot(cell: Cell): ControllerNode {
  if (cell.snap !== null) return cell.snap
  const children: ControllerNode[] = []
  for (const c of cell.children.values()) children.push(snapshot(c))
  const node: ControllerNode = { path: cell.path, state: cell.state, props: cell.props, children }
  if (cell.debug !== undefined) node.debug = cell.debug
  if (cell.disposedAt !== undefined) node.disposedAt = cell.disposedAt
  cell.snap = node
  return node
}

/** Replace every signal in a `ctx.debug` record by the value it holds now. */
function freezeDebug(debug: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(debug)) {
    if (!isSignalLike(v)) out[k] = v
    else {
      try {
        out[k] = v.peek()
      } catch (err) {
        out[k] = err
      }
    }
  }
  return out
}

/**
 * Subscribes to a root's `debug` bus and maintains live state for the
 * devtools panel. Exposes signals so the React layer can consume via
 * `@kontsedal/olas-react`'s `use()`.
 *
 * Pure logic — no DOM, no React. Construct one per root. Applying one event
 * costs O(1) plus O(path depth): nothing here scans the tree or a log.
 */
export class DevtoolsStore {
  /** The live controller tree. Unchanged subtrees keep their object identity. */
  readonly tree$: ReadSignal<ControllerNode>
  readonly cache$: ReadSignal<CacheEntry[]>
  readonly mutations$: ReadSignal<MutationEntry[]>
  readonly fields$: ReadSignal<FieldEntry[]>
  /** Unified causal timeline — every event, ordered by seq. A ring buffer. */
  readonly events$: ReadSignal<TimelineEvent[]>
  /** Timeline events the ring buffer overwrote since the last `clearLogs()`. */
  readonly droppedEvents$: ReadSignal<number>
  /**
   * Live cache-entry state for the inspector. Seeded from
   * `root.debug.queryEntries()` on `attach()`, then refreshed (coalesced) on
   * every cache / snapshot event — NO polling. Empty until attached.
   */
  readonly cacheState$: Signal<DebugCacheEntry[]> = signal([])
  /** Capacity of the timeline ring buffer. */
  readonly maxTimelineEntries: number

  private readonly cacheLog: Ring<CacheEntry>
  private readonly mutationLog: Ring<MutationEntry>
  private readonly fieldLog: Ring<FieldEntry>
  private readonly timeline: Ring<TimelineEvent>
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
  /** Last-seen data per entry (query id and key) — the baseline for the next set-data diff. */
  private lastDataByKey = new Map<string, unknown>()
  /** Source of the live cache snapshot, captured on `attach()`. */
  private queryEntries: (() => DebugCacheEntry[]) | undefined
  /**
   * Set when a cache / snapshot event arrives; drives a coalesced
   * `cacheState$` refresh in `flushPending` (replaces the old 800ms poll).
   */
  private cacheStateDirty = false

  /** The virtual root (path `[]`); the first real controller is its child. */
  private readonly rootCell: Cell = makeCell([], null)
  private readonly cells = new Map<string, Cell>([['', this.rootCell]])
  /**
   * Disposals in order: the pruning candidates, oldest first. An entry whose
   * `seq` is not its cell's latest `disposeSeq` is stale (the cell was
   * re-constructed, or disposed again later) and is skipped.
   */
  private disposedQueue: Array<{ cell: Cell; seq: number }> = []
  private disposedHead = 0
  private disposeSeq = 0
  private readonly treeRev = signal(0)
  private treeDirty = false

  /** Moves whenever anything the search index reads changed. */
  private rev = 0
  private readonly index = new SearchIndex()

  /**
   * Pending `run` start times, in a trie by controller path, then by mutation
   * name: a FIFO queue each. Overlapping runs of one mutation each pair with
   * their own start (T6.3). The trie lets a dispose drop a controller's
   * starts and all its descendants' in O(depth), where a flat map needed a
   * scan of every pending key.
   */
  private starts: StartNode = newStartNode()

  private flushHandle: number | null = null

  /**
   * When `true`, incoming events are DROPPED at the store boundary —
   * unlike the panel-side pause which only hides them. Useful for
   * profiling without skewing recorded timings and for "freeze the log
   * so I can read it" UX. The tree keeps updating: it is the current world.
   */
  private paused = false

  constructor(options?: DevtoolsStoreOptions) {
    const maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxTimelineEntries = options?.maxTimelineEntries ?? DEFAULT_MAX_TIMELINE_ENTRIES
    this.cacheLog = new Ring(maxEntries)
    this.mutationLog = new Ring(maxEntries)
    this.fieldLog = new Ring(maxEntries)
    this.timeline = new Ring(this.maxTimelineEntries)
    this.cache$ = this.cacheLog.view
    this.mutations$ = this.mutationLog.view
    this.fields$ = this.fieldLog.view
    this.events$ = this.timeline.view
    this.droppedEvents$ = this.timeline.dropped$
    this.tree$ = computed(() => {
      this.treeRev.value
      return snapshot(this.rootCell)
    })
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
  attach(root: Pick<Root<unknown>, 'debug'>): () => void {
    const unsub = root.debug.subscribe((event) => this.handle(event))
    // Seed the live cache snapshot ONCE (no interval); it's refreshed from
    // events thereafter — see `refreshCacheState`. This is what lets the
    // inspector be event-driven instead of polling every 800ms.
    this.queryEntries = () => root.debug.queryEntries()
    this.refreshCacheState()
    // Seed the per-key diff baseline from current live data too, so the first
    // post-attach write to an ALREADY-cached key diffs against its real value
    // rather than reading as an "initial" write (the fetch that populated it
    // happened before we subscribed).
    for (const e of this.cacheState$.peek()) {
      this.lastDataByKey.set(entryKey(e.queryId, e.key), e.data)
    }
    // The bus replayed the live tree synchronously inside `subscribe`; publish
    // it now rather than a frame later.
    this.flushPending()
    return unsub
  }

  /** Apply one event. Exposed for tests. */
  handle(event: DebugEvent): void {
    // Every event lands on the unified timeline (ordered by seq), regardless of
    // which specialized view (tree / cache / mutations / fields) it also feeds.
    this.pushTimeline(event)
    this.route(event)
    // The tree publishes at once, one notification per event however many
    // cells it touched: its lifecycle view never waits for a frame.
    if (this.treeDirty) {
      this.treeDirty = false
      this.treeRev.set(this.treeRev.peek() + 1)
    }
  }

  private route(event: DebugEvent): void {
    switch (event.type) {
      case 'controller:constructed': {
        const cell = this.ensureCell(event.path)
        cell.props = event.props
        // A re-construction after a dispose is a new instance: the frozen
        // variables belong to the old one.
        if (event.debug !== undefined) cell.debug = event.debug
        else if (cell.state === 'disposed') cell.debug = undefined
        cell.disposedAt = undefined
        this.setState(cell, 'active')
        this.touch(cell)
        return
      }
      case 'controller:debug': {
        const cell = this.cells.get(pathKey(event.path))
        if (cell === undefined) return
        cell.debug = event.values
        this.touch(cell)
        return
      }
      case 'controller:suspended':
      case 'controller:resumed': {
        const cell = this.cells.get(pathKey(event.path))
        if (cell !== undefined) {
          this.setState(cell, event.type === 'controller:suspended' ? 'suspended' : 'active')
        }
        return
      }
      case 'controller:disposed': {
        const cell = this.cells.get(pathKey(event.path))
        if (cell !== undefined) {
          // Freeze the dispose-time state: the controller's signals stop
          // meaning anything once it is gone, and holding them live would
          // keep its graph reachable from the panel.
          if (cell.debug !== undefined) cell.debug = freezeDebug(cell.debug)
          cell.disposedAt = event.t ?? this.now()
          this.setState(cell, 'disposed')
          this.touch(cell)
          cell.disposeSeq = ++this.disposeSeq
          this.disposedQueue.push({ cell, seq: cell.disposeSeq })
          this.pruneDisposed()
        }
        // A controller that disposed mid-mutation (before `success`/`error`
        // ever fired) would otherwise leave its `mutation:run` start entry
        // in `mutationStarts` forever. Drop any starts under this path.
        this.dropStartsForPath(event.path)
        return
      }
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
      case 'cache:gc': {
        // The entry is gone — drop its diff baseline so a later re-fetch of the
        // same key renders as an initial write (not a diff against a ghost
        // value), and so `lastDataByKey` stays bounded to live keys instead of
        // growing one entry per distinct key ever seen.
        this.lastDataByKey.delete(entryKey(event.queryId, event.queryKey))
        this.pushCache({ kind: 'gc', queryKey: event.queryKey })
        return
      }
      case 'mutation:run': {
        let node = this.starts
        for (const seg of event.path) {
          let kid = node.kids.get(seg)
          if (kid === undefined) {
            kid = newStartNode()
            node.kids.set(seg, kid)
          }
          node = kid
        }
        const name = event.name ?? ''
        const q = node.names.get(name)
        if (q === undefined) node.names.set(name, [this.now()])
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
   * Clear every log AND the unified timeline, and reset the dropped count.
   * Tree + live cache state are preserved — they reflect the current world,
   * not a history.
   */
  clearLogs(): void {
    batch(() => {
      this.cacheLog.clear()
      this.mutationLog.clear()
      this.fieldLog.clear()
      this.timeline.clear()
    })
    this.rev++
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
    this.starts = newStartNode()
  }

  /**
   * Search controllers, live queries, mutations, form fields and event
   * payloads for `query` (whitespace-separated terms, all must match,
   * case-insensitive). The index is built on the first search after a change
   * and reused until the next one, so typing costs no re-stringification.
   */
  search(query: string, limitPerKind?: number): SearchGroup[] {
    return this.index.search(
      query,
      this.rev,
      () => ({
        tree: this.tree$.peek(),
        entries: this.cacheState$.peek(),
        events: this.events$.peek(),
      }),
      limitPerKind,
    )
  }

  /** Search-index diagnostics: how often it was built, and how many values it turned into text. */
  searchStats(): SearchStats {
    return { ...this.index.stats }
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
    // `controller:debug` is a state (re)registration, not a causal event — it
    // updates the tree node's variables but doesn't belong on the timeline.
    if (event.type === 'controller:debug') return
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
      const key = entryKey(event.queryId, event.queryKey)
      // Capture the pre-write value for the diff, then advance the baseline.
      if (this.lastDataByKey.has(key)) entry.prev = this.lastDataByKey.get(key)
      this.lastDataByKey.set(key, event.data)
    }
    this.timeline.add(entry)
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
    this.rev++
  }

  private pushCache(entry: DistributiveOmit<CacheEntry, 'id' | 't'>): void {
    if (this.paused) return
    this.cacheLog.add({ id: this.nextId++, t: this.now(), ...entry } as CacheEntry)
    this.scheduleFlush()
  }

  private pushMutation(entry: DistributiveOmit<MutationEntry, 'id' | 't'>): void {
    if (this.paused) return
    this.mutationLog.add({ id: this.nextId++, t: this.now(), ...entry } as MutationEntry)
    this.scheduleFlush()
  }

  private pushField(entry: Omit<FieldEntry, 'id' | 't'>): void {
    if (this.paused) return
    this.fieldLog.add({ id: this.nextId++, t: this.now(), ...entry })
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
    batch(() => {
      let moved = this.cacheLog.flush()
      moved = this.mutationLog.flush() || moved
      moved = this.fieldLog.flush() || moved
      moved = this.timeline.flush() || moved
      if (moved) this.rev++
      // Coalesced inspector refresh — one snapshot read per frame no matter how
      // many cache events landed, and only when something actually changed.
      if (this.cacheStateDirty) this.refreshCacheState()
    })
  }

  // ---- the keyed tree -----------------------------------------------------

  /** The cell at `path`, creating it and any missing ancestors as active placeholders. */
  private ensureCell(path: readonly string[]): Cell {
    const existing = this.cells.get(pathKey(path))
    if (existing !== undefined) return existing
    const parent = this.ensureCell(path.slice(0, -1))
    const cell = makeCell(path, parent)
    parent.children.set(cell.segment, cell)
    this.cells.set(cell.key, cell)
    for (let p: Cell | null = parent; p !== null; p = p.parent) {
      p.size++
      p.live++
    }
    this.touch(parent)
    return cell
  }

  private setState(cell: Cell, next: ControllerNode['state']): void {
    if (cell.state === next) return
    const delta = (next !== 'disposed' ? 1 : 0) - (cell.state !== 'disposed' ? 1 : 0)
    cell.state = next
    if (delta !== 0) for (let p: Cell | null = cell; p !== null; p = p.parent) p.live += delta
    this.touch(cell)
  }

  /**
   * Invalidate the cached snapshot of `cell` and its ancestors. Stops at the
   * first ancestor already invalid: an invalid node's ancestors are invalid
   * too, so the walk is O(depth) at worst and O(1) in a burst.
   */
  private touch(cell: Cell): void {
    for (let c: Cell | null = cell; c !== null && c.snap !== null; c = c.parent) c.snap = null
    this.rev++
    this.treeDirty = true
  }

  /**
   * Remove the earliest-disposed fully-disposed subtrees once the retained
   * disposed count exceeds `maxDisposedNodes`. A candidate with a live
   * descendant is skipped: when that descendant disposes it is queued, and
   * pruning it prunes the ancestor with it. Each candidate is looked at once.
   */
  private pruneDisposed(): void {
    const root = this.rootCell
    const q = this.disposedQueue
    while (root.size - root.live > this.maxDisposedNodes && this.disposedHead < q.length) {
      const { cell, seq } = q[this.disposedHead++] as { cell: Cell; seq: number }
      if (seq !== cell.disposeSeq || cell.removed || cell.live !== 0 || cell === root) continue
      // Prune the largest fully-disposed subtree containing it, never the root.
      let top = cell
      while (top.parent !== null && top.parent !== root && top.parent.live === 0) top = top.parent
      this.removeCell(top)
    }
    // Drop consumed and stale entries once they outnumber the live ones, so a
    // session that disposes and re-constructs the same paths keeps the queue
    // bounded by the disposed count. Amortized O(1) per dispose.
    const head = this.disposedHead
    if (q.length - head > 2 * (root.size - root.live) + 64 || (head > 64 && head * 2 > q.length)) {
      this.disposedQueue = q
        .slice(head)
        .filter(
          (e) => e.seq === e.cell.disposeSeq && !e.cell.removed && e.cell.state === 'disposed',
        )
      this.disposedHead = 0
    }
  }

  private removeCell(cell: Cell): void {
    const parent = cell.parent as Cell
    parent.children.delete(cell.segment)
    for (let p: Cell | null = parent; p !== null; p = p.parent) p.size -= cell.size
    const stack = [cell]
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      c.removed = true
      this.cells.delete(c.key)
      for (const child of c.children.values()) stack.push(child)
    }
    this.touch(parent)
  }

  // ---- mutation timing ----------------------------------------------------

  private consumeStart(path: readonly string[], name: string | undefined): number | undefined {
    const trail: StartNode[] = [this.starts]
    for (const seg of path) {
      const kid = (trail[trail.length - 1] as StartNode).kids.get(seg)
      if (kid === undefined) return undefined
      trail.push(kid)
    }
    const node = trail[trail.length - 1] as StartNode
    const q = node.names.get(name ?? '')
    if (q === undefined) return undefined
    // FIFO: pair this settle with the OLDEST pending start so overlapping runs
    // of the same mutation each get a duration (T6.3). Exact run↔settle
    // attribution isn't possible — the debug bus carries no per-run id — but
    // FIFO never loses a start the way the old single-value map did.
    const startedAt = q.shift() as number
    if (q.length === 0) node.names.delete(name ?? '')
    // Prune the now-empty tail of the path, so the trie holds only paths
    // with a run in flight.
    for (let i = trail.length - 1; i > 0; i--) {
      const n = trail[i] as StartNode
      if (n.names.size > 0 || n.kids.size > 0) break
      ;(trail[i - 1] as StartNode).kids.delete(path[i - 1] as string)
    }
    return this.now() - startedAt
  }

  /**
   * Drop every pending mutation-start record under `path` (and its
   * descendants). Called on `controller:disposed` so a dispose mid-mutation
   * doesn't leave a start behind forever.
   */
  private dropStartsForPath(path: readonly string[]): void {
    let node: StartNode | undefined = this.starts
    for (let i = 0; i < path.length - 1 && node !== undefined; i++) {
      node = node.kids.get(path[i] as string)
    }
    if (path.length === 0) this.starts = newStartNode()
    else node?.kids.delete(path[path.length - 1] as string)
  }
}

/** One controller-path segment of the pending-start trie. */
type StartNode = { names: Map<string, number[]>; kids: Map<string, StartNode> }

function newStartNode(): StartNode {
  return { names: new Map(), kids: new Map() }
}

/**
 * Distributes `Omit` over a discriminated union so each variant keeps its own
 * keys. The default `Omit<A | B, K>` collapses to the intersection of keys —
 * not what we want when constructing one variant at a time.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

// ---------------------------------------------------------------------------
// Pure, immutable tree helpers. The store no longer uses them — it keeps a
// keyed, mutable tree — but they stay public for code that builds a
// `ControllerNode` tree by hand.
// ---------------------------------------------------------------------------

/**
 * Insert (or update) a node at `path` inside the tree. Auto-creates any
 * missing intermediate ancestors as 'active' placeholders.
 *
 * Returns a NEW tree object (immutable update).
 */
export function insertNode(
  root: ControllerNode,
  path: readonly string[],
  props: unknown,
  debug?: Record<string, unknown>,
): ControllerNode {
  return updateAt(
    root,
    path,
    0,
    (node) => ({ ...node, state: 'active', props, ...(debug !== undefined ? { debug } : {}) }),
    true,
  ) as ControllerNode
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
  return updateAt(root, path, 0, (node) => ({ ...node, state }), false) ?? root
}

/**
 * Set the `debug` variables record on the node at `path`. Returns the tree
 * unchanged if the node doesn't exist (out-of-order delivery).
 */
export function setNodeDebug(
  root: ControllerNode,
  path: readonly string[],
  debug: Record<string, unknown>,
): ControllerNode {
  return updateAt(root, path, 0, (node) => ({ ...node, debug }), false) ?? root
}

/**
 * Path-copying update of the node at `path`. With `create`, missing nodes are
 * made as active placeholders; without it, a missing node returns null.
 */
function updateAt(
  node: ControllerNode,
  path: readonly string[],
  depth: number,
  fn: (node: ControllerNode) => ControllerNode,
  create: boolean,
): ControllerNode | null {
  if (depth === path.length) return fn(node)
  const segment = path[depth] as string
  // Match by both segment AND depth, so children whose paths end in the same
  // string at different levels never alias.
  const idx = node.children.findIndex(
    (c) => c.path.length === depth + 1 && c.path[depth] === segment,
  )
  if (idx === -1 && !create) return null
  const child: ControllerNode = node.children[idx] ?? {
    path: path.slice(0, depth + 1),
    state: 'active',
    props: undefined,
    children: [],
  }
  const updated = updateAt(child, path, depth + 1, fn, create)
  if (updated === null) return null
  const children = node.children.slice()
  if (idx === -1) children.push(updated)
  else children[idx] = updated
  return { ...node, children }
}
