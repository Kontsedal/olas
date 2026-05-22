import type { DebugEvent, Root } from '@kontsedal/olas-core'
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

/** Defaults — exported so callers can override via `new DevtoolsStore({ maxEntries: 500 })`. */
export const DEFAULT_MAX_ENTRIES = 100

export type DevtoolsStoreOptions = {
  /** Cap on each event log (cache, mutation, field). Oldest entries drop first. */
  maxEntries?: number
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

  private readonly maxEntries: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void) => number
  private readonly cancelSchedule: (handle: number) => void
  private nextId = 1

  /** Keyed by `path|name` so a mutation:run can be paired with its
   *  success/error to compute duration. Cleared after pairing. */
  private mutationStarts = new Map<string, number>()

  /**
   * Coalesce buffers — events arrive synchronously off the bus but
   * commits to the signals happen at most once per frame, so the React
   * panel re-renders at a sane rate even under 1000 evt/sec bursts.
   */
  private pendingCache: CacheEntry[] = []
  private pendingMutations: MutationEntry[] = []
  private pendingFields: FieldEntry[] = []
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
      this.schedule =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn: () => void) => setTimeout(fn, 0) as unknown as number
      this.cancelSchedule =
        typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame
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
    return root.__debug.subscribe((event) => this.handle(event))
  }

  /** Apply one event. Exposed for tests. */
  handle(event: DebugEvent): void {
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
        this.pushCache({ kind: 'gc', queryKey: event.queryKey })
        return
      case 'mutation:run': {
        this.mutationStarts.set(mutationKey(event.path, event.name), this.now())
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

  /** Clear every log. Tree state is preserved — the live tree is not a log. */
  clearLogs(): void {
    this.cache$.set([])
    this.mutations$.set([])
    this.fields$.set([])
    // Drop pending coalesce buffers too — a scheduled flush after `clearLogs`
    // would otherwise revive entries the user just cleared.
    this.pendingCache = []
    this.pendingMutations = []
    this.pendingFields = []
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
  }

  private consumeStart(path: readonly string[], name: string | undefined): number | undefined {
    const key = mutationKey(path, name)
    const startedAt = this.mutationStarts.get(key)
    if (startedAt === undefined) return undefined
    this.mutationStarts.delete(key)
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
}

function mutationKey(path: readonly string[], name: string | undefined): string {
  return `${path.join('>')}#${name ?? ''}`
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
