import {
  batch,
  computed,
  defineScope,
  type OlasPlugin,
  type QueryHost,
  type ReadSignal,
  type Scope,
  type Signal,
  signal,
} from '@kontsedal/olas-core'

// Core's brand keys. `Symbol.for`, so these are the same runtime symbols core
// uses; core does not export them, and a symbol key keeps them out of
// autocomplete and `Object.keys`.
const BRAND: unique symbol = Symbol.for('olas.brand')
declare const PHANTOM: unique symbol

/**
 * Module-scoped descriptor for an entity type. Define one per entity class
 * (`Post`, `User`, `Comment`), then pass the resulting handles to
 * `entitiesPlugin({ entities: [...] })`.
 *
 * `idOf` extracts a string id from a value if it IS an entity of this type,
 * or returns `null` / `undefined` if it isn't. The plugin uses `idOf` both
 * to walk query results (testing every reachable subtree value) and to look
 * up entities in the store. Falsy returns are treated as "not an entity."
 *
 * The phantom type slot lets `entities.signal(Post, id)` return
 * `ReadSignal<Post | undefined>` rather than a type-erased `unknown`.
 */
export type EntityDef<T> = {
  readonly [BRAND]: 'entity'
  readonly name: string
  readonly idOf: (value: unknown) => string | null | undefined
  /**
   * Optional canonicalness check. When set, the auto-walker only writes a
   * value into the store if `isCanonical(value)` returns `true`. Used to
   * prevent stub references (e.g. `{ id: '1' }` embedded as a foreign key)
   * from overwriting fully-hydrated entities in the store.
   *
   * Idiom: check for fields that only appear on the full record.
   *
   * ```ts
   * defineEntity<Post>({
   *   name: 'Post',
   *   idOf: (v: any) => v?.id ?? null,
   *   isCanonical: (v: any) => 'title' in v && 'body' in v,
   * })
   * ```
   *
   * When omitted, every entity-shaped value is canonical.
   */
  readonly isCanonical?: (value: unknown) => boolean
  /**
   * Soft cap on the number of unique ids retained in this entity's slot
   * partition. When set and the partition exceeds the cap, the plugin
   * evicts **orphans** (entity ids no longer referenced by any query)
   * in LRU order on the next slot insertion. Slots with active bindings
   * are never evicted — call sites that subscribed via
   * `entities.signal(...)` keep working. If all slots have bindings the
   * cap is exceeded silently (no other safe option).
   *
   * Untuned partitions still emit a one-shot dev warning at the
   * `SLOT_BLOAT_WARN_AT` threshold so you notice unbounded growth without
   * having to set a cap upfront.
   */
  readonly maxSlots?: number
  /**
   * Phantom — not present at runtime. Pins the entity's value type. Kept in
   * covariant position (a property, not a parameter) so `EntityDef<Post>` is
   * assignable to `EntityDef<unknown>` — the user passes `[Post, User]` to
   * `entitiesPlugin({ entities })`, and the array's element type widens cleanly.
   */
  readonly [PHANTOM]?: T
}

/** What `defineEntity` takes. */
export type EntityOptions<T> = {
  /** Unique among the entities one plugin is given; the store's partition key. */
  name: string
  /** The entity's id when `value` is one of this type, else `null` / `undefined`. */
  idOf: (value: T) => string | null | undefined
  /** See `EntityDef.isCanonical`. */
  isCanonical?: (value: T) => boolean
  /** Soft cap on unique ids retained — see `EntityDef.maxSlots`. */
  maxSlots?: number
}

/**
 * Declare an entity type. `name` MUST be unique within a plugin instance;
 * the plugin uses it as the partition key in the normalized store and the
 * reverse index. `idOf` is a type-narrowing predicate masquerading as a
 * partial function: return the id when the value matches this entity's
 * shape, `null` (or `undefined`) when it doesn't.
 *
 * Idiom: include a discriminating field check inside `idOf` so unrelated
 * objects with an `id` field don't get falsely classified.
 *
 * @example
 * ```ts
 * type Post = { id: string; title: string; likes: number }
 * const Post = defineEntity<Post>({
 *   name: 'Post',
 *   idOf: (v: any) => (v && typeof v.id === 'string' && typeof v.title === 'string')
 *     ? v.id
 *     : null,
 * })
 * ```
 */
export function defineEntity<T>(opts: EntityOptions<T>): EntityDef<T> {
  return {
    [BRAND]: 'entity',
    name: opts.name,
    // Type-erase: the plugin calls idOf on arbitrary subtree values during
    // the walk, so the runtime contract is `(unknown) => string | null`.
    idOf: opts.idOf as (value: unknown) => string | null | undefined,
    isCanonical: opts.isCanonical as ((value: unknown) => boolean) | undefined,
    maxSlots: opts.maxSlots,
  }
}

/**
 * Path from a query's root data to an entity instance. Numeric segments
 * are array indices, string segments are object keys. Stored as a plain
 * array so the cost of building and walking it stays minimal.
 */
type Path = ReadonlyArray<string | number>

/**
 * One binding of (entityId → location inside a query). A single entity can
 * have multiple paths within the same query (e.g. `data.posts[3]` and
 * `data.pinned` may both be the same Post by id).
 */
type Binding = {
  queryId: string
  keyArgs: readonly unknown[]
  paths: Path[]
}

/** Public, frozen view of a binding — for `entities.bindings(...)` devtools. */
export type EntityBinding = {
  readonly queryId: string
  readonly keyArgs: readonly unknown[]
  readonly paths: ReadonlyArray<ReadonlyArray<string | number>>
}

/**
 * Per-entity threshold beyond which we warn (once) that the store has
 * accumulated many unique ids — past it, set `maxSlots` on the entity so
 * orphans are evicted.
 */
const SLOT_BLOAT_WARN_AT = 10_000

/**
 * Plain-object test for deep-merge. Mirrors the walker's recursion rule:
 * we merge into Arrays / plain Objects, but NEVER into class instances,
 * Date, Map, Set — those replace wholesale. This avoids accidentally
 * "merging" a `Date` (`{ ...new Date() }` is `{}`) or a class with private
 * state.
 */
const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Recursive merge for `entities.update(..., { merge: 'deep' })`. Plain
 * objects merge key-by-key; arrays REPLACE (no deep-array merge — see
 * lodash debate); non-plain values replace. Returns a new top-level object.
 *
 * Cost: O(patch-size). Existing subtrees not mentioned by `patch` keep
 * their reference, so the post-`setData` walk's `Object.is` dedup still
 * terminates the auto-walk loop after one cycle.
 */
const deepMerge = (current: object, patch: object): object => {
  if (!isPlainObject(current) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...current }
  for (const key of Object.keys(patch)) {
    const a = (current as Record<string, unknown>)[key]
    const b = (patch as Record<string, unknown>)[key]
    if (isPlainObject(a) && isPlainObject(b)) {
      out[key] = deepMerge(a, b)
    } else {
      out[key] = b
    }
  }
  return out
}

/**
 * One root's normalized entity store — the service `entitiesPlugin` provides.
 * Reach it through the `Entities` scope: `ctx.inject(Entities)` in a
 * controller, `root.inject(Entities)` outside one.
 *
 * Per-entity ops are typed by the `EntityDef<T>` you pass in — `signal(Post, id)`
 * returns `ReadSignal<Post | undefined>`, not `ReadSignal<unknown>`.
 */
export type EntityStore = {
  /**
   * Reactive per-id signal. Components subscribe via the framework adapter
   * (`use(entities.signal(Post, id))` in `@kontsedal/olas-react`). The
   * signal is `undefined` until the entity is observed via a query or
   * explicit `upsert`.
   *
   * Stable across calls — `signal(Post, '123')` twice returns the same
   * handle (lazy per-id allocation, interned in a `Map`).
   *
   * Throws if `entity` wasn't passed to `entitiesPlugin({ entities })` —
   * without the partition slot, the signal would be orphaned and updates
   * would never reach it.
   */
  signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined>
  /** Non-reactive read. Equivalent to `signal(entity, id).peek()`. */
  get<T>(entity: EntityDef<T>, id: string): T | undefined
  /**
   * Explicitly add or replace an entity in the normalized store. Useful when
   * an entity arrives from a source the plugin doesn't observe — a
   * WebSocket event handler that doesn't write through a query cache, a
   * preload from `localStorage`, etc.
   *
   * `value` MUST satisfy `entity.idOf(value)`. If `idOf` returns `null`
   * the call is a silent no-op (the plugin can't store a value without an
   * id — entity types are identity-based).
   */
  upsert<T>(entity: EntityDef<T>, value: T): void
  /**
   * Patch an entity AND every query that holds it. The patch is either a
   * `Partial<T>` (merged with `current` per `options.merge`) or an updater
   * function `(prev: T) => T` for computed updates.
   *
   * `options.merge` controls how `Partial<T>` patches combine with the
   * current value (no effect when `patch` is an updater function):
   *
   * - `'shallow'` (default) — `{ ...current, ...patch }`. Nested fields
   *   in `patch` REPLACE the corresponding nested field on `current`.
   * - `'deep'` — recursively merge plain objects key-by-key. Arrays and
   *   non-plain values (Date, class instances, Map/Set) REPLACE; primitives
   *   replace. Cycles in the patch short-circuit at the cycle node.
   *
   * Each query holding the entity gets a `setData` write that immutably
   * replaces the entity at every path where it appears. Writes are wrapped
   * in `batch(...)` so a single update produces one round of subscriber
   * notifications, even when N queries are affected.
   *
   * When the entity isn't in the store, `update` is a no-op. A
   * `console.warn` fires in dev builds — production builds silently bail.
   * Call `entities.upsert(...)` first if you want create-or-patch semantics.
   */
  update<T extends object>(
    entity: EntityDef<T>,
    id: string,
    patch: Partial<T> | ((prev: T) => T),
    options?: { merge?: 'shallow' | 'deep' },
  ): void
  /**
   * Remove the entity from the normalized store. Does NOT patch queries — a
   * query still holding the entity in its data stays as-is, and nothing
   * refetches. Pair with a query `write` to remove the entity from a list too.
   */
  remove<T>(entity: EntityDef<T>, id: string): void
  /**
   * Snapshot of the entity store for a single entity type. Devtools /
   * debugging only — returns a fresh `Map<id, T>` each call (no live
   * subscription). The returned Map is a copy; mutating it does NOT
   * affect the store.
   */
  entries<T>(entity: EntityDef<T>): ReadonlyMap<string, T>
  /**
   * Reverse-index lookup. Returns every binding (queryId + keyArgs + paths)
   * where the entity at `id` currently lives. Empty array when the entity
   * isn't in any query (orphan in the store, or never observed). Devtools
   * only — bindings are deep-frozen to prevent accidental mutation.
   */
  bindings<T>(entity: EntityDef<T>, id: string): ReadonlyArray<EntityBinding>
  /**
   * Live `ReadSignal<T[]>` of every entity of this type currently in the
   * store. Re-derives whenever any slot for the entity is written; uses
   * `Object.is` dedup at the slot level so per-id no-op writes don't
   * re-render the list.
   *
   * Optional `filter` is applied per item (post-`undefined`-filter); apply
   * sort by piping the result through a `computed` if needed.
   *
   * This is a *denormalized read* — Apollo-style — for "give me every
   * Post the store knows about" use cases. Unlike returning a query's
   * `data`, the list updates immediately when any entity mutates via
   * `entities.update()` or a `setData` write reaches the walker.
   */
  list<T>(entity: EntityDef<T>, options?: { filter?: (value: T) => boolean }): ReadSignal<T[]>
}

/** The plugin's name — and the `origin` stamped on its backprop writes. */
export const ENTITIES_PLUGIN_NAME = 'olas-entities'

/**
 * The scope `entitiesPlugin` provides its store under. Resolve it with
 * `ctx.inject(Entities)` in a controller or `root.inject(Entities)` outside
 * one. In a test, seed a fake with `RootOptions.scopes`.
 */
export const Entities: Scope<EntityStore> = defineScope<EntityStore>({ name: 'olas-entities' })

/** Options for `entitiesPlugin(...)`. */
export type EntitiesOptions = {
  /** Every entity type the store normalizes. Names must be unique. */
  readonly entities: ReadonlyArray<EntityDef<unknown>>
}

/**
 * Build the entity-normalization plugin:
 *
 * ```ts
 * createRoot(App, {
 *   deps,
 *   queries: queryEngine(),
 *   plugins: [entitiesPlugin({ entities: [Post, User] })],
 * })
 *
 * // in a controller
 * const entities = ctx.inject(Entities)
 * entities.update(Post, 'p1', { liked: true })
 * ```
 *
 * Lifecycle:
 * - On every cache write, the plugin walks the written data and finds every
 *   subtree value that a registered entity claims via `idOf`. It updates both
 *   the normalized store and the reverse index (entity-id → bindings).
 * - On `update`, it reads the reverse index for the entity and writes the
 *   patch into every binding with `host.queries.write`, inside one `batch`
 *   so subscribers see one round of notifications.
 * - Regular and infinite queries are both observed. The store is per root:
 *   each root the plugin is installed in gets its own.
 */
export function entitiesPlugin(options: EntitiesOptions): OlasPlugin {
  // Validate names — duplicates would silently corrupt the store partitioning.
  const byName = new Map<string, EntityDef<unknown>>()
  for (const e of options.entities) {
    if (byName.has(e.name)) {
      throw new Error(
        `[olas/entities] duplicate entity name "${e.name}" — every defineEntity({ name })` +
          ' passed to entitiesPlugin must be unique.',
      )
    }
    byName.set(e.name, e)
  }
  return {
    name: ENTITIES_PLUGIN_NAME,
    setup(host) {
      const queries = host.queries
      if (queries === null) {
        throw new Error(
          '[olas/entities] entitiesPlugin needs a query engine: ' +
            'createRoot(app, { queries: queryEngine(), plugins: [entitiesPlugin({ … })] })',
        )
      }
      const { store, observe, forget, dispose } = createEntityStore(byName, queries)
      host.provide(Entities, store)
      return {
        onWrite(event) {
          // Its own backprop writes put values the store already holds.
          if (event.origin === ENTITIES_PLUGIN_NAME) return
          observe(event.query.id, event.key, event.data)
        },
        onRemove(event) {
          // Entities referenced only by the removed entry drop out of the
          // reverse index, but their value stays in the store — so an open
          // detail view subscribed through `signal(Post, id)` keeps working,
          // and a later fetch re-establishes bindings without losing identity.
          forget(event.query.id, event.key)
        },
        dispose,
      }
    },
  }
}

/** One root's store and the hooks that feed it. */
function createEntityStore(
  byName: ReadonlyMap<string, EntityDef<unknown>>,
  queries: QueryHost,
): {
  store: EntityStore
  observe: (queryId: string, keyArgs: readonly unknown[], data: unknown) => void
  forget: (queryId: string, keyArgs: readonly unknown[]) => void
  dispose: () => void
} {
  // Normalized store. `signal(undefined)` is created lazily on first
  // `signal(entity, id)` so consumers can subscribe to entities they
  // haven't seen yet (without forcing the plugin to materialize a slot for
  // every theoretical id).
  const store = new Map<string, Map<string, Signal<unknown>>>()
  for (const name of byName.keys()) store.set(name, new Map())

  // Per-entity "list version" signal — bumps every time a slot is added,
  // removed, or its value changes. Powers the reactive `list()` API
  // without forcing every consumer to walk the full store on each read.
  // A version counter is the cheapest reactive lever; a `computed` over
  // it derives the list lazily, only when actually read.
  const listVersion = new Map<string, Signal<number>>()
  for (const name of byName.keys()) listVersion.set(name, signal(0))
  const bumpListVersion = (name: string): void => {
    const v = listVersion.get(name)
    if (v !== undefined) v.set(v.peek() + 1)
  }

  // reverseIndex[entityName][id][bindingKey] → Binding
  const reverseIndex = new Map<string, Map<string, Map<string, Binding>>>()
  for (const name of byName.keys()) reverseIndex.set(name, new Map())

  // forwardIndex[bindingKey] → { entityName → ids found inside that query }
  // Used to know which reverse-index entries to clean up before re-walking
  // an entry that was already observed.
  const forwardIndex = new Map<string, Map<string, Set<string>>>()

  // `dispose()` empties `store`, which is also what `assertRegistered`
  // probes for registration. Without this flag a post-dispose call reports
  // "was not registered" and sends the reader looking for a missing
  // `entitiesPlugin([...])` entry that is right there.
  let disposed = false
  // Per-entity one-shot "you're growing without bound" warning gate. We
  // don't want a noisy console; the warning fires once per partition.
  const bloatWarned = new Set<string>()

  /**
   * Reject calls referencing an EntityDef that wasn't passed to
   * `entitiesPlugin({ entities })`. Without this, `signal(Foo, id)` for an
   * unregistered Foo would allocate a fresh orphan signal per call (no
   * partition map to intern it in), break handle stability, and leak.
   */
  const assertRegistered = (
    entity: EntityDef<unknown>,
    op: string,
  ): Map<string, Signal<unknown>> => {
    if (disposed) {
      throw new Error(
        `[olas/entities] entities.${op}: the store was disposed with its owning root.` +
          ' Every entity signal it handed out is dead; read from a live root instead.',
      )
    }
    const part = store.get(entity.name)
    if (part === undefined) {
      throw new Error(
        `[olas/entities] entities.${op}: entity "${entity.name}" was not registered with` +
          ' entitiesPlugin({ entities }). Add the EntityDef to that array.',
      )
    }
    return part
  }

  /**
   * Evict orphan slots (no bindings in the reverse index) in LRU order
   * until `part.size <= cap` or no more orphans exist. Bound slots are
   * never evicted — callers subscribed to their signals stay live.
   *
   * Map iteration is insertion order; combined with `getSlot`'s LRU-touch
   * (delete + set on every hit), the head of the Map is the least-recently
   * touched, so we walk forward and evict.
   */
  const trimOrphans = (
    entityName: string,
    part: Map<string, Signal<unknown>>,
    cap: number,
    protectedId?: string,
  ): void => {
    if (part.size <= cap) return
    const perEntity = reverseIndex.get(entityName)
    const toEvict: string[] = []
    let projected = part.size
    for (const id of part.keys()) {
      if (projected <= cap) break
      // The slot we just inserted / promoted is the most-recently-used by
      // definition — never evict it in the same call that touched it.
      if (id === protectedId) continue
      const bindings = perEntity?.get(id)
      if (bindings === undefined || bindings.size === 0) {
        toEvict.push(id)
        projected -= 1
      }
    }
    if (toEvict.length === 0) return
    for (const id of toEvict) {
      const slot = part.get(id)
      if (slot === undefined) continue
      // Settle subscribers to `undefined` before dropping the slot — anyone
      // still holding the signal handle sees the eviction explicitly rather
      // than a silently-stuck stale value.
      slot.set(undefined)
      part.delete(id)
    }
    bumpListVersion(entityName)
  }

  const getSlot = (
    part: Map<string, Signal<unknown>>,
    entityName: string,
    id: string,
  ): Signal<unknown> => {
    let slot = part.get(id)
    if (slot === undefined) {
      slot = signal<unknown>(undefined)
      part.set(id, slot)
      // New slot — `list()` consumers want to see this id appear. We bump
      // here even though the value is `undefined` because the next walker
      // / upsert pass usually populates it within the same batch.
      bumpListVersion(entityName)
      if (__DEV__ && part.size > SLOT_BLOAT_WARN_AT && !bloatWarned.has(entityName)) {
        bloatWarned.add(entityName)
        // eslint-disable-next-line no-console
        console.warn(
          `[olas/entities] entity "${entityName}" has ${part.size} unique ids in the store.` +
            ' If this keeps growing unbounded, set { maxSlots } on defineEntity.',
        )
      }
      const cap = byName.get(entityName)?.maxSlots
      if (cap !== undefined && part.size > cap) trimOrphans(entityName, part, cap, id)
    } else {
      // LRU touch — promote to most-recently-used by re-inserting at the tail.
      // Map.delete + Map.set preserves the same Signal reference (callers
      // holding it stay subscribed), but the Map's insertion-order iterator
      // now lists `id` last.
      part.delete(id)
      part.set(id, slot)
    }
    return slot
  }

  /**
   * Append a binding for (entityName, id) at `key` with `path`. We clone
   * `path` here (`.slice()`) because the walker reuses one mutable
   * accumulator array — without this clone, every binding would alias the
   * same in-flight path and mutate as the walk advances.
   */
  const addBinding = (
    entityName: string,
    id: string,
    key: string,
    queryId: string,
    keyArgs: readonly unknown[],
    path: Path,
  ): void => {
    const perEntity = reverseIndex.get(entityName)
    if (perEntity === undefined) return
    let perId = perEntity.get(id)
    if (perId === undefined) {
      perId = new Map()
      perEntity.set(id, perId)
    }
    const existing = perId.get(key)
    if (existing === undefined) {
      perId.set(key, { queryId, keyArgs, paths: [path.slice()] })
    } else {
      existing.paths.push(path.slice())
    }
  }

  const removeBindingsForKey = (key: string): void => {
    const prevIds = forwardIndex.get(key)
    if (prevIds === undefined) return
    for (const [entityName, ids] of prevIds) {
      const perEntity = reverseIndex.get(entityName)
      if (perEntity === undefined) continue
      for (const id of ids) {
        const perId = perEntity.get(id)
        if (perId === undefined) continue
        perId.delete(key)
        if (perId.size === 0) perEntity.delete(id)
      }
    }
    forwardIndex.delete(key)
  }

  /**
   * Recursively walk `value` for entities. For every subtree node that any
   * registered entity claims via `idOf`, upsert it into the store and
   * record the path under the (queryId, keyArgs) binding.
   *
   * Cycle handling: `inProgress` is a `WeakSet` of objects currently being
   * descended into. We add on entry, remove on exit. A true cycle hits a
   * node already in `inProgress` and short-circuits. A shared-reference
   * DAG (same Post object reached via two different paths) does NOT short-
   * circuit, because the second visit happens AFTER the first has popped —
   * so both paths get recorded.
   *
   * Path accumulator: `path` is one mutable array reused across the whole
   * walk; we push on descent and pop on ascent. Callers that record the
   * path (`addBinding`) must clone it.
   *
   * Cost: O(reachable-nodes). For most query payloads (KB-range JSON) this
   * is negligible. Map / Set / Date / class instances are NOT walked into
   * — we only recurse on Array and plain Object (own enumerable string
   * keys). Non-enumerable / symbol keys are intentionally invisible.
   */
  const walk = (
    value: unknown,
    queryId: string,
    keyArgs: readonly unknown[],
    key: string,
    path: Array<string | number>,
    inProgress: WeakSet<object>,
    foundIds: Map<string, Set<string>>,
  ): void => {
    if (value === null || typeof value !== 'object') return
    if (inProgress.has(value as object)) return // true cycle — bail
    inProgress.add(value as object)

    // Entity-claim check first. We probe ALL registered entities (not just
    // one) because the same object could plausibly satisfy multiple
    // definitions (rare but legal).
    for (const def of byName.values()) {
      const id = def.idOf(value)
      if (id == null) continue
      addBinding(def.name, id, key, queryId, keyArgs, path)
      // `isCanonical` guards stub-reference writes. A foreign-key embedding
      // like `{ id: '1' }` should NOT overwrite the canonical Post stored
      // by an earlier fully-hydrated fetch. The reverse-index binding is
      // still recorded so backprop into this slot still works — only the
      // store write is gated.
      if (def.isCanonical !== undefined && !def.isCanonical(value)) {
        let ids = foundIds.get(def.name)
        if (ids === undefined) {
          ids = new Set()
          foundIds.set(def.name, ids)
        }
        ids.add(id)
        continue
      }
      // Object.is dedup at the signal level — re-setting the same reference
      // is a no-op. This is what breaks the "auto-walk → upsert → setData
      // → auto-walk" loop after `update()`.
      const part = store.get(def.name)
      if (part !== undefined) {
        const slot = getSlot(part, def.name, id)
        const prev = slot.peek()
        slot.set(value)
        if (!Object.is(prev, value)) bumpListVersion(def.name)
      }
      let ids = foundIds.get(def.name)
      if (ids === undefined) {
        ids = new Set()
        foundIds.set(def.name, ids)
      }
      ids.add(id)
    }

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        path.push(i)
        walk(value[i], queryId, keyArgs, key, path, inProgress, foundIds)
        path.pop()
      }
    } else {
      for (const k of Object.keys(value as Record<string, unknown>)) {
        path.push(k)
        walk(
          (value as Record<string, unknown>)[k],
          queryId,
          keyArgs,
          key,
          path,
          inProgress,
          foundIds,
        )
        path.pop()
      }
    }

    inProgress.delete(value as object)
  }

  /**
   * The binding key for one query entry. Built from the engine's own key
   * hash, so an entities binding collides with the cache entry it points at
   * exactly when the same key would.
   */
  const bindingKey = (queryId: string, keyArgs: readonly unknown[]): string =>
    `${queryId}\u0000${queries.hashKey(keyArgs)}`

  const observe = (queryId: string, keyArgs: readonly unknown[], data: unknown): void => {
    // Regular and infinite entries are both walked. For an infinite one,
    // `data` is `TPage[]` — the walker's path accumulator records
    // `[pageIdx, ...inPagePath]` automatically, and `queries.write` routes a
    // backprop write into the pages the same way.
    const key = bindingKey(queryId, keyArgs)
    // Drop the previous walk's bindings for this entry first. Entities that
    // disappeared from the query (e.g. a Post removed from a list) lose
    // their reverse-index entry here.
    removeBindingsForKey(key)

    const foundIds = new Map<string, Set<string>>()
    walk(data, queryId, keyArgs, key, [], new WeakSet(), foundIds)

    if (foundIds.size > 0) {
      forwardIndex.set(key, foundIds)
    }
  }

  /**
   * Put every entity nested inside `value` into the store, but not `value`
   * itself. For an `update` whose entity no query holds: nothing re-walks it,
   * and a nested entity the patch brought in would otherwise never land.
   */
  const absorbNested = (value: unknown, seen: WeakSet<object>, isRoot: boolean): void => {
    if (value === null || typeof value !== 'object' || seen.has(value as object)) return
    seen.add(value as object)
    if (!isRoot) {
      for (const def of byName.values()) {
        const id = def.idOf(value)
        if (id == null) continue
        if (def.isCanonical !== undefined && !def.isCanonical(value)) continue
        const part = store.get(def.name)
        if (part === undefined) continue
        const slot = getSlot(part, def.name, id)
        const prev = slot.peek()
        slot.set(value)
        if (!Object.is(prev, value)) bumpListVersion(def.name)
      }
    }
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    for (const child of children) absorbNested(child, seen, false)
  }

  /**
   * Immutably replace the value at `path` inside `root`. Returns a new
   * structure that shares siblings by reference — unchanged subtrees stay
   * `===` to their original, which is what the signal-equality dedup
   * relies on to terminate the post-`update` walk.
   *
   * Defensive: if the path doesn't lead anywhere (e.g., the array slot
   * was removed by an earlier write), we return `root` unchanged.
   */
  const setAtPath = (root: unknown, path: Path, value: unknown): unknown => {
    if (path.length === 0) return value
    const head = path[0] as string | number
    const rest = path.slice(1)
    if (typeof head === 'number') {
      if (!Array.isArray(root)) return root
      if (head < 0 || head >= root.length) return root
      const next = root.slice()
      next[head] = setAtPath(root[head], rest, value)
      return next
    }
    if (root === null || typeof root !== 'object' || Array.isArray(root)) return root
    if (!(head in (root as Record<string, unknown>))) return root
    return {
      ...(root as Record<string, unknown>),
      [head]: setAtPath((root as Record<string, unknown>)[head], rest, value),
    }
  }

  const entityStore: EntityStore = {
    signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined> {
      const part = assertRegistered(entity, 'signal')
      return getSlot(part, entity.name, id) as unknown as ReadSignal<T | undefined>
    },

    get<T>(entity: EntityDef<T>, id: string): T | undefined {
      const part = assertRegistered(entity, 'get')
      // `get` is a non-reactive peek — it MUST NOT allocate a slot. Doing so
      // would mean `entities.get(Post, 'never-seen')` materializes empty
      // partition entries and (with `maxSlots`) could even trigger LRU
      // eviction of real data. Use `entities.signal(...)` when you need
      // stable-handle semantics for an id that may not yet exist.
      const slot = part.get(id)
      return slot === undefined ? undefined : (slot.peek() as T | undefined)
    },

    upsert<T>(entity: EntityDef<T>, value: T): void {
      const part = assertRegistered(entity, 'upsert')
      const id = entity.idOf(value as unknown)
      if (id == null) return
      const slot = getSlot(part, entity.name, id)
      const prev = slot.peek()
      slot.set(value as unknown)
      if (!Object.is(prev, value)) bumpListVersion(entity.name)
    },

    update<T extends object>(
      entity: EntityDef<T>,
      id: string,
      patch: Partial<T> | ((prev: T) => T),
      options?: { merge?: 'shallow' | 'deep' },
    ): void {
      const part = assertRegistered(entity, 'update')
      // Peek the partition directly — `getSlot` would allocate an empty slot
      // and LRU-touch under `maxSlots`, polluting the store with `undefined`
      // entries for ids that were never seen. Only promote when we actually
      // have something to update.
      const existing = part.get(id)
      const current = existing === undefined ? undefined : (existing.peek() as T | undefined)
      if (current === undefined) {
        if (__DEV__) {
          // eslint-disable-next-line no-console
          console.warn(
            `[olas/entities] entities.update("${entity.name}", "${id}", ...) called but no` +
              ' entity is currently in the store for that id. The call is a no-op; use' +
              ' entities.upsert(...) first if you intended create-or-patch semantics.',
          )
        }
        return
      }
      // We have an existing slot — LRU-touch it now via getSlot so this
      // update counts as a recent use against `maxSlots`.
      const slot = getSlot(part, entity.name, id)
      let next: T
      if (typeof patch === 'function') {
        next = (patch as (prev: T) => T)(current)
      } else if (options?.merge === 'deep') {
        next = deepMerge(current as object, patch as object) as T
      } else {
        next = { ...(current as object), ...(patch as object) } as T
      }
      const bindingsMap = reverseIndex.get(entity.name)?.get(id)
      // Snapshot the bindings before the loop: another plugin reacting to a
      // backprop write can re-enter this store synchronously and reshape the
      // live Map mid-iteration.
      const bindingsSnapshot = bindingsMap === undefined ? [] : Array.from(bindingsMap.values())

      // Wrap store + backprop writes in a single batch so subscribers see
      // one round of notifications across the entity store and every
      // affected query.
      batch(() => {
        slot.set(next as unknown)
        if (!Object.is(current, next)) bumpListVersion(entity.name)
        for (const binding of bindingsSnapshot) {
          const paths = binding.paths
          // Stamped with this plugin's name as `origin`, so its own `onWrite`
          // skips it; the re-walk below stands in for that walk.
          queries.write(binding.queryId, binding.keyArgs, (prev) => {
            let result: unknown = prev
            for (const path of paths) {
              result = setAtPath(result, path, next as unknown)
            }
            return result
          })
          // Re-walk the entry: a nested entity the patch brought in (a new
          // author, say) is normalized, and the entry's bindings follow the
          // patch instead of keeping the entity it replaced. The walk writes
          // nothing back to the cache, so it cannot loop.
          observe(binding.queryId, binding.keyArgs, queries.peek(binding.queryId, binding.keyArgs))
        }
        if (bindingsSnapshot.length === 0) absorbNested(next, new WeakSet(), true)
      })
    },

    remove<T>(entity: EntityDef<T>, id: string): void {
      const part = assertRegistered(entity, 'remove')
      const slot = part.get(id)
      if (slot === undefined) return
      slot.set(undefined)
      part.delete(id)
      bumpListVersion(entity.name)
      // Drop reverse-index entries for this id across every binding.
      // Forward-index entries that reference it stay (cheap; next walk
      // rebuilds them); the asymmetry just avoids a full forwardIndex
      // sweep here.
      const perEntity = reverseIndex.get(entity.name)
      perEntity?.delete(id)
    },

    entries<T>(entity: EntityDef<T>): ReadonlyMap<string, T> {
      const part = assertRegistered(entity, 'entries')
      // Snapshot — returning the live Map of Signals would leak internals
      // (subscribers writing through it could corrupt the store). Each
      // call yields a fresh Map<id, T> with shallow-cloned + frozen values.
      //
      // Why clone+freeze instead of returning peeked refs directly: the
      // peeked value IS the same reference held inside the per-id signal.
      // If the consumer mutates a property on it, every component reading
      // `entities.signal(Post, id)` sees the corruption AND the entity
      // store's Object.is dedup silently swallows the next legitimate
      // update at that field (because `===` still holds). Shallow-clone
      // breaks the reference; freeze catches in-strict-mode mutation
      // attempts at the top level. Nested mutation is still possible but
      // documented; deep clone would be O(payload) per call.
      const out = new Map<string, T>()
      for (const [id, slot] of part) {
        const v = slot.peek()
        if (v === undefined) continue
        if (v !== null && typeof v === 'object') {
          out.set(
            id,
            Object.freeze(Array.isArray(v) ? [...v] : { ...(v as object) }) as unknown as T,
          )
        } else {
          out.set(id, v as T)
        }
      }
      return out
    },

    list<T>(entity: EntityDef<T>, options?: { filter?: (value: T) => boolean }): ReadSignal<T[]> {
      assertRegistered(entity, 'list')
      const version = listVersion.get(entity.name)
      // `assertRegistered` already throws if the entity wasn't passed to
      // entitiesPlugin({ entities }) — the version map is in lock-step with
      // byName/store, so this is just for the type system.
      if (version === undefined) return computed(() => []) as ReadSignal<T[]>
      const filter = options?.filter
      return computed<T[]>(() => {
        // Tracked dep — re-derive on every store mutation that touches
        // this entity. The `void` is intentional: we don't need the
        // counter value, only the dependency.
        void version.value
        const part = store.get(entity.name)
        if (part === undefined) return []
        const out: T[] = []
        for (const slot of part.values()) {
          const v = slot.peek() as T | undefined
          if (v === undefined) continue
          if (filter !== undefined && !filter(v)) continue
          out.push(v)
        }
        return out
      })
    },

    bindings<T>(entity: EntityDef<T>, id: string): ReadonlyArray<EntityBinding> {
      assertRegistered(entity, 'bindings')
      const perId = reverseIndex.get(entity.name)?.get(id)
      if (perId === undefined || perId.size === 0) return []
      const out: EntityBinding[] = []
      for (const binding of perId.values()) {
        // Defensive copy: don't expose the live `Binding` (its `paths` is
        // mutated by `addBinding`). We freeze the keyArgs array AND each
        // path so devtools authors can't accidentally feed a mutated
        // binding back into anything that hashes by reference. Inner
        // keyArgs items aren't deep-frozen — that would cost O(payload).
        out.push(
          Object.freeze({
            queryId: binding.queryId,
            keyArgs: Object.freeze([...binding.keyArgs]) as readonly unknown[],
            paths: Object.freeze(
              binding.paths.map((p) => Object.freeze(p.slice()) as ReadonlyArray<string | number>),
            ) as ReadonlyArray<ReadonlyArray<string | number>>,
          }),
        )
      }
      return out
    },
  }

  const dispose = (): void => {
    // `disposed` has to be set alongside the clears, because an emptied
    // store is indistinguishable from "never registered" to `assertRegistered`.
    disposed = true
    store.clear()
    reverseIndex.clear()
    forwardIndex.clear()
    bloatWarned.clear()
  }

  return {
    store: entityStore,
    observe,
    forget: (queryId, keyArgs) => removeBindingsForKey(bindingKey(queryId, keyArgs)),
    dispose,
  }
}
