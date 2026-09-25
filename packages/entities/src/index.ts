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
   * evicts **orphans** in LRU order on the next slot insertion: ids no query
   * holds and no `subscribe` on their `entities.signal(...)` handle holds, so
   * a mounted view keeps its entity. An open `subscribe` holds even when the
   * caller kept only its unsubscribe. If every slot is held the cap is
   * exceeded silently (no other safe option).
   *
   * A handle read through `.value` in a `computed` or an `effect` does not
   * hold its slot. Eviction reads as `undefined` through it, and the handle
   * follows the entity again once a query or `upsert` brings it back.
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
  /**
   * Unique among the entities one plugin is given; the store's partition key.
   */
  name: string
  /**
   * The entity's id when `value` is one of this type, else `null` / `undefined`.
   */
  idOf: (value: T) => string | null | undefined
  /**
   * See `EntityDef.isCanonical`.
   */
  isCanonical?: (value: T) => boolean
  /**
   * Soft cap on unique ids retained — see `EntityDef.maxSlots`.
   */
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
 *
 * The reverse index uses a binding to know WHICH entries hold an entity.
 * `update` does not follow `paths`: it finds the entity in the entry's
 * current data (`replaceEntity`). The paths are for `bindings()`.
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
 * A handle `signal(entity, id)` gave out, and the `subscribe` calls open on it.
 * `held` pins the handle while one is open: a caller may keep only the
 * unsubscribe, and a collected handle would take the count with it.
 */
type HandleEntry = {
  ref: WeakRef<ReadSignal<unknown>>
  watchers: number
  held?: ReadSignal<unknown> | undefined
}

/**
 * What a slot holds once it has left its partition. Setting it notifies the
 * handles that read the slot, even when its value was already `undefined`.
 */
const DETACHED: unique symbol = Symbol('olas-entities.detached')

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
 * Set `key` on `out` as an own data property. An assignment `out[key] = v`
 * with the key `__proto__` would replace the prototype instead, and a value
 * parsed from JSON can carry that key.
 */
const defineOwn = (out: object, key: string, value: unknown): void => {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
}

/**
 * A shallow copy of `record` with its prototype: a class instance stays an
 * instance, and a null-prototype object stays one. `{ ...record }` returns a
 * plain object. Own enumerable string keys are copied through `defineOwn`,
 * so an own `__proto__` key stays data (`.wiki/pitfalls/proto-key-assignment.md`).
 * Private fields and non-enumerable properties are not copied.
 */
const copyRecord = (record: object): Record<string, unknown> => {
  const out = Object.create(Object.getPrototypeOf(record)) as Record<string, unknown>
  for (const key of Object.keys(record))
    defineOwn(out, key, (record as Record<string, unknown>)[key])
  return out
}

/** `{ ...current, ...patch }` that keeps `current`'s prototype. */
const shallowMerge = (current: object, patch: object): object => {
  const out = copyRecord(current)
  for (const key of Object.keys(patch)) defineOwn(out, key, (patch as Record<string, unknown>)[key])
  return out
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
  const out = copyRecord(current)
  for (const key of Object.keys(patch)) {
    // Own properties only, read and written: `current['__proto__']` reads the
    // prototype, and `out['__proto__'] = v` replaces it. A patch parsed from
    // JSON can carry that key, so it is copied as the plain data it is.
    const a = Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined
    const b = (patch as Record<string, unknown>)[key]
    defineOwn(out, key, isPlainObject(a) && isPlainObject(b) ? deepMerge(a, b) : b)
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
   * handle for as long as anything holds it. The handle survives `remove`
   * and `maxSlots` eviction: it reads `undefined` while the entity is out of
   * the store, and follows the entity again once a query or `upsert` brings
   * it back.
   *
   * Throws if `entity` wasn't passed to `entitiesPlugin({ entities })` —
   * without the partition slot, the signal would be orphaned and updates
   * would never reach it.
   */
  signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined>
  /**
   * Non-reactive read. Equivalent to `signal(entity, id).peek()`.
   */
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
   * Each query entry the reverse index lists gets one canonical write that
   * replaces every node `idOf` claims with this id, found in the entry's
   * current data, so a patch lands on an entity that moved since the entry
   * was last walked. The write is a patch of the entity as that entry holds
   * it, not the store's value: the engine re-runs it on each optimistic
   * baseline (SPEC §6.4), so a guess pending on one query never reaches
   * another query, or the value a rollback restores. An updater `patch`
   * therefore runs once per entry and once per baseline, and must be pure.
   * Every object the patch rebuilds keeps its prototype. An entry that no
   * longer holds the entity gets no write. Writes are wrapped in
   * `batch(...)` so a single update produces one round of subscriber
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
   * A handle from `signal(entity, id)` reads `undefined` until a query or
   * `upsert` brings the entity back, and then follows it again.
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
  /**
   * Every entity type the store normalizes. Names must be unique.
   */
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
      const { store, observe, forget, dispose } = createEntityStore(byName, queries, (payload) =>
        host.debug(payload),
      )
      host.provide(Entities, store)
      return {
        onWrite(event) {
          // Its own backprop writes put values the store already holds.
          if (event.origin === ENTITIES_PLUGIN_NAME) return
          // Walk what the entry holds now, not `event.data`. A plugin earlier
          // in the list can write this entry again, or call `update`, before
          // this hook sees the event; walking the older value would put stale
          // entities back into the store and bind paths into data that is
          // gone. `event.data` stands in when the engine cannot find the entry.
          const current = queries.peek(event.query.id, event.key)
          observe(event.query.id, event.key, current === undefined ? event.data : current)
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
  /** The plugin's devtools lane (`host.debug`). Called only in development builds. */
  debug: (payload: unknown) => void,
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

  // Per-entity counter bumped each time a slot is allocated. A handle whose id
  // has no slot reads it, so it picks the new slot up when the entity returns.
  const arrivals = new Map<string, Signal<number>>()
  for (const name of byName.keys()) arrivals.set(name, signal(0))

  // The handles `signal(entity, id)` gave out, held weakly: an id a view
  // looked at once must not pin a handle forever. `watchers` counts the
  // `subscribe` calls open on a handle; eviction never takes a watched slot.
  const handles = new Map<string, Map<string, HandleEntry>>()
  for (const name of byName.keys()) handles.set(name, new Map())
  const collected = new FinalizationRegistry<{ name: string; id: string; entry: HandleEntry }>(
    ({ name, id, entry }) => {
      const perEntity = handles.get(name)
      if (perEntity?.get(id) === entry) perEntity.delete(id)
    },
  )
  const isWatched = (entityName: string, id: string): boolean =>
    (handles.get(entityName)?.get(id)?.watchers ?? 0) > 0

  /**
   * Take a slot out of its partition. The slot is set to `DETACHED` after it
   * leaves the map, so a handle that read it re-evaluates, finds no slot, and
   * waits on `arrivals` instead of holding a signal nothing writes again.
   */
  const detach = (part: Map<string, Signal<unknown>>, id: string, slot: Signal<unknown>): void => {
    part.delete(id)
    slot.set(DETACHED)
  }

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
   * Evict orphan slots in LRU order until `part.size <= cap` or no more
   * orphans exist. An orphan has no bindings in the reverse index and no
   * `subscribe` open on its handle, so neither a query nor a mounted view
   * loses its entity.
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
      if ((bindings === undefined || bindings.size === 0) && !isWatched(entityName, id)) {
        toEvict.push(id)
        projected -= 1
      }
    }
    if (toEvict.length === 0) return
    for (const id of toEvict) {
      const slot = part.get(id)
      if (slot === undefined) continue
      // A handle still held reads `undefined` now, and follows the entity
      // again when it returns.
      detach(part, id, slot)
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
      // A handle waiting for this id picks the slot up.
      const arrived = arrivals.get(entityName)
      if (arrived !== undefined) arrived.set(arrived.peek() + 1)
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
   * Write `value` into the slot for (entityName, id). Re-setting the same
   * reference is a no-op for the signal (`Object.is`), and that is what breaks
   * the "auto-walk → upsert → setData → auto-walk" loop after `update()`.
   */
  const putSlot = (entityName: string, id: string, value: unknown): void => {
    const part = store.get(entityName)
    if (part === undefined) return
    const slot = getSlot(part, entityName, id)
    const prev = slot.peek()
    slot.set(value)
    if (!Object.is(prev, value)) bumpListVersion(entityName)
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
   * The binding key for one query entry. Built from the engine's own key
   * hash, so an entities binding collides with the cache entry it points at
   * exactly when the same key would.
   */
  const bindingKey = (queryId: string, keyArgs: readonly unknown[]): string =>
    `${queryId}\u0000${queries.hashKey(keyArgs)}`

  /**
   * Walk one entry's `data` for entities: every node a registered entity
   * claims is upserted into the store and its path recorded under the entry's
   * binding. The bindings the previous walk of the entry recorded are dropped
   * first, so an entity that left the query (a Post removed from a list) loses
   * its reverse-index entry.
   *
   * Each object is descended into once per walk:
   * - A node on the current descent path (`inProgress`) is a cycle back to
   *   an ancestor. It is skipped, with no claim.
   * - A node already walked (`walked`) is a shared reference, such as one
   *   Post object at `posts[3]` and at `pinned`. Its own claims are recorded
   *   at this path too, but its subtree is not walked again. An entity nested
   *   inside it is bound at the path the walk first reached it by.
   *
   * The second rule keeps a DAG linear. A chain of diamonds, where each level
   * points at the next through two keys, has 2^depth paths to its bottom, and
   * walking every path would take that long. `update` does not need the paths:
   * it finds the entity in the entry's current data (`replaceEntity`).
   *
   * Path accumulator: `path` is one mutable array reused across the whole
   * walk; we push on descent and pop on ascent. Callers that record the
   * path (`addBinding`) must clone it.
   *
   * Regular and infinite entries are both walked. For an infinite one, `data`
   * is `TPage[]`, so a path starts with the page index.
   *
   * Cost: O(reachable objects + the references between them) `idOf` calls
   * per registered entity. Only arrays and objects are descended into, by
   * their own enumerable string keys (`Object.keys`), so a Map, a Set or a
   * Date contributes no children. Symbol keys are invisible.
   */
  const observe = (queryId: string, keyArgs: readonly unknown[], data: unknown): void => {
    const key = bindingKey(queryId, keyArgs)
    removeBindingsForKey(key)
    const foundIds = new Map<string, Set<string>>()
    const path: Array<string | number> = []
    const inProgress = new Set<object>()
    const walked = new Set<object>()

    // Record the claims on one node at `path`: a binding for every registered
    // entity whose `idOf` claims it, and a store write unless `isCanonical`
    // rejects it. All entities are probed, because one object can satisfy
    // several definitions (rare but legal).
    const claim = (node: object): void => {
      for (const def of byName.values()) {
        const id = def.idOf(node)
        if (id == null) continue
        addBinding(def.name, id, key, queryId, keyArgs, path)
        let ids = foundIds.get(def.name)
        if (ids === undefined) {
          ids = new Set()
          foundIds.set(def.name, ids)
        }
        ids.add(id)
        // `isCanonical` guards stub-reference writes. A foreign-key embedding
        // like `{ id: '1' }` should NOT overwrite the canonical Post stored
        // by an earlier fully-hydrated fetch. The binding is still recorded,
        // so a backprop still reaches the stub; only the store write is gated.
        if (def.isCanonical !== undefined && !def.isCanonical(node)) continue
        putSlot(def.name, id, node)
      }
    }

    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const node = value as object
      if (inProgress.has(node)) return
      claim(node)
      if (walked.has(node)) return
      walked.add(node)
      inProgress.add(node)
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          path.push(i)
          walk(node[i])
          path.pop()
        }
      } else {
        for (const k of Object.keys(node)) {
          path.push(k)
          walk((node as Record<string, unknown>)[k])
          path.pop()
        }
      }
      inProgress.delete(node)
    }

    walk(data)
    if (foundIds.size > 0) forwardIndex.set(key, foundIds)
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
        putSlot(def.name, id, value)
      }
    }
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)
    for (const child of children) absorbNested(child, seen, false)
  }

  /**
   * The first node in `root` that `def` claims as `id` and `isCanonical`
   * accepts, found by the traversal `walk` uses. `undefined` when `root`
   * holds only stubs of the entity, or none.
   */
  const canonicalIn = (root: unknown, def: EntityDef<unknown>, id: string): unknown => {
    const seen = new Set<object>()
    const find = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object' || seen.has(node)) return undefined
      seen.add(node)
      if (def.idOf(node) === id && (def.isCanonical === undefined || def.isCanonical(node))) {
        return node
      }
      const children = Array.isArray(node) ? node : Object.values(node as Record<string, unknown>)
      for (const child of children) {
        const found = find(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    return find(root)
  }

  /**
   * `root` with every node that `def` claims as `id` replaced by one patched
   * record, plus how many distinct nodes matched. It reads the data it is
   * given, so a patch lands on an entity that moved after the entry was last
   * walked, and never on whatever took its old place.
   *
   * The record is `patch` of the entity as this data holds it: its first
   * canonical copy, or `fallback` when the data holds only stubs. The engine
   * re-runs a canonical write on each optimistic baseline (SPEC §6.4), and a
   * baseline holds the entity without the guess, so each baseline gets its
   * own patched record. Every copy in one data, a stub included, gets the
   * same one.
   *
   * The rebuild is immutable and structural. An unchanged subtree keeps its
   * reference, which is what the signal-equality dedup relies on to end the
   * post-`update` walk, and `root` itself comes back when nothing changed.
   * A rebuilt object keeps its prototype (`copyRecord`). A shared subtree is
   * rebuilt once and stays shared, so the cost is one `idOf` call per
   * reachable object, however many paths lead to it. A cycle back to an
   * ancestor keeps pointing at the original object. The traversal matches
   * `walk`: arrays, and objects by `Object.keys`.
   */
  const replaceEntity = (
    root: unknown,
    def: EntityDef<unknown>,
    id: string,
    patch: (record: unknown) => unknown,
    fallback: unknown,
  ): { data: unknown; matched: number } => {
    const done = new Map<object, unknown>()
    let matched = 0
    let patched: { value: unknown } | undefined
    // `visit` meets the copies in `canonicalIn`'s order, so a first match that
    // is canonical is the first canonical copy, and the search is skipped.
    const record = (first: object): unknown => {
      if (patched === undefined) {
        const canonical =
          def.isCanonical === undefined || def.isCanonical(first)
            ? first
            : canonicalIn(root, def, id)
        patched = { value: patch(canonical !== undefined ? canonical : fallback) }
      }
      return patched.value
    }
    const visit = (node: unknown): unknown => {
      if (node === null || typeof node !== 'object') return node
      if (done.has(node)) return done.get(node)
      if (def.idOf(node) === id) {
        matched += 1
        const value = record(node)
        done.set(node, value)
        return value
      }
      // Set before descending, so a cycle back here resolves to the original.
      done.set(node, node)
      let out: unknown[] | Record<string, unknown> | undefined
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
          const child = visit(node[i])
          if (Object.is(child, node[i])) continue
          out ??= node.slice()
          ;(out as unknown[])[i] = child
        }
      } else {
        const record = node as Record<string, unknown>
        for (const k of Object.keys(record)) {
          const child = visit(record[k])
          if (Object.is(child, record[k])) continue
          out ??= copyRecord(record)
          defineOwn(out, k, child)
        }
      }
      const result = out ?? node
      done.set(node, result)
      return result
    }
    return { data: visit(root), matched }
  }

  /**
   * The handle for one id: a read of whatever slot the partition holds for it
   * now. `remove` and eviction drop a slot, and a later walk or `upsert`
   * allocates a new one, so the handle looks the slot up on every evaluation
   * instead of keeping the first one. With no slot it reads `undefined` and
   * waits on `arrivals`. It is cached weakly, and counts the `subscribe`
   * calls open on it for `trimOrphans`.
   */
  const handleFor = (
    entityName: string,
    part: Map<string, Signal<unknown>>,
    id: string,
  ): ReadSignal<unknown> => {
    const perEntity = handles.get(entityName) as Map<string, HandleEntry>
    const cached = perEntity.get(id)?.ref.deref()
    if (cached !== undefined) return cached
    const arrived = arrivals.get(entityName) as Signal<number>
    const read = computed<unknown>(() => {
      const slot = part.get(id)
      if (slot !== undefined) return slot.value
      void arrived.value
      return undefined
    })
    const entry = { watchers: 0 } as HandleEntry
    const watch = (off: () => void): (() => void) => {
      // Through the weak ref: a closure naming `handle` would let the
      // unsubscribe it returns pin the handle after it closes.
      if (entry.watchers++ === 0) entry.held = entry.ref.deref()
      let open = true
      return () => {
        if (!open) return
        open = false
        if (--entry.watchers === 0) entry.held = undefined
        off()
      }
    }
    const handle: ReadSignal<unknown> = {
      get value() {
        return read.value
      },
      peek: () => read.peek(),
      subscribe: (fn) => watch(read.subscribe(fn)),
      subscribeChanges: (fn) => watch(read.subscribeChanges(fn)),
    }
    entry.ref = new WeakRef(handle)
    perEntity.set(id, entry)
    collected.register(handle, { name: entityName, id, entry })
    return handle
  }

  const entityStore: EntityStore = {
    signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined> {
      const part = assertRegistered(entity, 'signal')
      // Allocate the slot, or LRU-touch it: asking for an entity counts as a
      // recent use under `maxSlots`.
      getSlot(part, entity.name, id)
      return handleFor(entity.name, part, id) as ReadSignal<T | undefined>
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
      assertRegistered(entity, 'upsert')
      const id = entity.idOf(value as unknown)
      if (id == null) return
      putSlot(entity.name, id, value)
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
      // The patch as a function of one copy of the entity. It runs on each
      // copy a query holds, not once on the store's: the store follows the
      // data on screen, guesses included, and a canonical write built from it
      // would carry a pending guess into every query and every baseline.
      const apply = (record: unknown): unknown => {
        if (typeof patch === 'function') return (patch as (prev: T) => T)(record as T)
        if (record === null || typeof record !== 'object') return patch
        return options?.merge === 'deep'
          ? deepMerge(record, patch as object)
          : shallowMerge(record, patch as object)
      }
      const next = apply(current) as T
      const def = entity as EntityDef<unknown>
      const bindingsMap = reverseIndex.get(entity.name)?.get(id)
      // Snapshot the bindings before the loop: another plugin reacting to a
      // backprop write can re-enter this store synchronously and reshape the
      // live Map mid-iteration.
      const bindingsSnapshot = bindingsMap === undefined ? [] : Array.from(bindingsMap.values())
      // For the devtools lane: the query id of each entry the patch was
      // written into, and how many listed entries no longer held the entity.
      const reached: string[] = []
      let stale = 0

      // Wrap store + backprop writes in a single batch so subscribers see
      // one round of notifications across the entity store and every
      // affected query.
      batch(() => {
        slot.set(next as unknown)
        if (!Object.is(current, next)) bumpListVersion(entity.name)
        for (const binding of bindingsSnapshot) {
          const { queryId, keyArgs } = binding
          // Patch the entry as it is now. The binding says which entry holds
          // the entity, not where: the entry can have changed since its last
          // walk (a plugin earlier in the list rewrote it, or reacted to a
          // backprop write), and a recorded path would miss the entity or
          // land on what took its place.
          const prev = queries.peek(queryId, keyArgs)
          const { data, matched } = replaceEntity(prev, def, id, apply, next)
          if (matched === 0) {
            // The entry no longer holds the entity. Nothing to patch; the
            // re-walk drops the binding.
            if (__DEV__) stale += 1
            observe(queryId, keyArgs, prev)
            continue
          }
          // An updater that returned the stored value changes nothing.
          if (data === prev) continue
          // A patch, not a whole value: the engine re-runs it on each live
          // optimistic baseline (SPEC §6.4), where it patches the entity as
          // that baseline holds it. The data on screen reuses the result
          // computed above. Stamped with this plugin's name as `origin`, so
          // its own `onWrite` skips it; the re-walk below stands in for that walk.
          queries.write(queryId, keyArgs, (base) =>
            base === prev ? data : replaceEntity(base, def, id, apply, next).data,
          )
          if (__DEV__) reached.push(queryId)
          // Re-walk the entry: a nested entity the patch brought in (a new
          // author, say) is normalized, and the entry's bindings follow the
          // patch instead of keeping the entity it replaced. The walk writes
          // nothing back to the cache, so it cannot loop.
          observe(queryId, keyArgs, queries.peek(queryId, keyArgs))
        }
        if (bindingsSnapshot.length === 0) absorbNested(next, new WeakSet(), true)
      })
      // The backprop fan-out, on the plugin's devtools lane.
      if (__DEV__) {
        debug({
          kind: 'update',
          entity: entity.name,
          id,
          entries: reached.length,
          stale,
          queries: reached,
        })
      }
    },

    remove<T>(entity: EntityDef<T>, id: string): void {
      const part = assertRegistered(entity, 'remove')
      const slot = part.get(id)
      if (slot === undefined) return
      // A handle reads `undefined` now, and follows the entity again when a
      // query or `upsert` brings it back.
      detach(part, id, slot)
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
    handles.clear()
    bloatWarned.clear()
  }

  return {
    store: entityStore,
    observe,
    forget: (queryId, keyArgs) => removeBindingsForKey(bindingKey(queryId, keyArgs)),
    dispose,
  }
}
