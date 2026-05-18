import type { DebugEvent, Root } from '@olas/core'
import { type Signal, signal } from '@olas/core'

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

/** One entry in the mutation log. */
export type MutationEntry =
  | { id: number; t: number; kind: 'run'; path: readonly string[]; vars: unknown }
  | { id: number; t: number; kind: 'success'; path: readonly string[]; result: unknown }
  | { id: number; t: number; kind: 'error'; path: readonly string[]; error: unknown }
  | { id: number; t: number; kind: 'rollback'; path: readonly string[] }

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
}

/**
 * Subscribes to a root's `__debug` bus and maintains live state for the
 * devtools panel. Exposes signals so the React layer can consume via
 * `@olas/react`'s `use()`.
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
  private nextId = 1

  constructor(options?: DevtoolsStoreOptions) {
    this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = options?.now ?? (() => Date.now())
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
      case 'mutation:run':
        this.pushMutation({ kind: 'run', path: event.path, vars: event.vars })
        return
      case 'mutation:success':
        this.pushMutation({ kind: 'success', path: event.path, result: event.result })
        return
      case 'mutation:error':
        this.pushMutation({ kind: 'error', path: event.path, error: event.error })
        return
      case 'mutation:rollback':
        this.pushMutation({ kind: 'rollback', path: event.path })
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
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private pushCache(entry: DistributiveOmit<CacheEntry, 'id' | 't'>): void {
    const full = { id: this.nextId++, t: this.now(), ...entry } as CacheEntry
    this.cache$.set(appendBounded(this.cache$.peek(), full, this.maxEntries))
  }

  private pushMutation(entry: DistributiveOmit<MutationEntry, 'id' | 't'>): void {
    const full = { id: this.nextId++, t: this.now(), ...entry } as MutationEntry
    this.mutations$.set(appendBounded(this.mutations$.peek(), full, this.maxEntries))
  }

  private pushField(entry: Omit<FieldEntry, 'id' | 't'>): void {
    const full = { id: this.nextId++, t: this.now(), ...entry } as FieldEntry
    this.fields$.set(appendBounded(this.fields$.peek(), full, this.maxEntries))
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

function appendBounded<T>(arr: readonly T[], item: T, max: number): T[] {
  const next = arr.length >= max ? arr.slice(arr.length - max + 1) : arr.slice()
  next.push(item)
  return next
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
  const idx = node.children.findIndex((c) => c.path[c.path.length - 1] === segment)
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
  const idx = node.children.findIndex((c) => c.path[c.path.length - 1] === segment)
  if (idx === -1) return null
  const existing = node.children[idx]!
  const updatedChild = setStateAt(existing, path, depth + 1, state)
  if (updatedChild === null) return null
  const nextChildren = node.children.slice()
  nextChildren[idx] = updatedChild
  return { ...node, children: nextChildren }
}
