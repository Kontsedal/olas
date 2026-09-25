---
name: entities
description: "@kontsedal/olas-entities — entity normalization as an OlasPlugin: a linear auto-walk of each entry's current data on every write, a reverse index, backprop that finds the entity in the entry as it is now, the store as the Entities scope service, and a devtools lane."
type: module
covers:
  - packages/entities/src/index.ts
  - packages/entities/tsdown.config.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: related, target: ../decisions/esm-only-build.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: documented-in, target: ../../BACKLOG.md }
  - { type: tested-by, target: ../../packages/entities/tests/entities.test.ts }
  - { type: tested-by, target: ../../packages/entities/tests/coverage-store-edges.test.ts }
  - { type: tested-by, target: ../../packages/entities/tests/merge-security.test.ts }
  - { type: tested-by, target: ../../packages/entities/tests/devtools-lane.test.ts }
  - { type: tested-by, target: ../../packages/integration/tests/cross-tab-entities.test.ts }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: query.md }
  - { type: uses, target: signals.md }
  - { type: related, target: cross-tab.md }
  - { type: related, target: devtools-panel.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-entities`

An `OlasPlugin` built on the plugin host (`../flows/plugin-lifecycle.md`, SPEC §13). It solves the cross-query update problem of SPEC §18.1. When one `Post` lives in `newsfeedQuery`, `profileQuery` and `searchQuery`, one `update(Post, id, patch)` patches every query holding that id.

```ts
import { createQuery, createRoot, defineController, defineQuery, queryEngine } from '@kontsedal/olas-core'
import { defineEntity, Entities, entitiesPlugin } from '@kontsedal/olas-entities'

type Post = { id: string; title: string; liked: boolean }

const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v) => (typeof v?.id === 'string' && typeof v?.title === 'string' ? v.id : null),
})

const feedQuery = defineQuery({
  id: 'posts/feed',
  key: () => ['feed'],
  fetcher: async (): Promise<Post[]> => [],
})

const app = defineController((ctx) => {
  const feed = createQuery(ctx, feedQuery)
  const entities = ctx.inject(Entities)
  return { feed, like: (id: string) => entities.update(Post, id, { liked: true }) }
})

export const root = createRoot(app, {
  deps: {},
  queries: queryEngine(),
  plugins: [entitiesPlugin({ entities: [Post] })],
})
```

## Surface

| Name | Signature | Notes |
|---|---|---|
| `defineEntity<T>` | `({ name, idOf, isCanonical?, maxSlots? }) => EntityDef<T>` | Module scope. `idOf(value)` returns the id when the value is this entity, else `null` or `undefined` (`packages/entities/src/index.ts:84-87`). |
| `entitiesPlugin` | `({ entities }) => OlasPlugin` | A duplicate `name` throws when `entitiesPlugin` is called (`index.ts:361-372`). The value is a definition: each root it is installed in gets its own store. `setup` throws without a query engine (`index.ts:375-382`). |
| `Entities` | `Scope<EntityStore>` | `setup` provides the store under it (`index.ts:326`, `index.ts:383-386`). Read it with `ctx.inject(Entities)` or `root.inject(Entities)`. A test seeds a fake through `RootOptions.scopes`. |
| `ENTITIES_PLUGIN_NAME` | `'olas-entities'` | The plugin's name, and the `origin` of its backprop writes (`index.ts:319`). |
| `store.signal(entity, id)` | `ReadSignal<T \| undefined>` | Allocated on first call and stable after it. Throws for an entity the plugin was not given. |
| `store.get(entity, id)` | `T \| undefined` | Non-reactive. Allocates no slot (`index.ts:805-814`). |
| `store.upsert(entity, value)` | `void` | For sources no query carries, such as a WebSocket event. A value whose `idOf` is null is ignored. |
| `store.update(entity, id, patch, { merge? })` | `void` | Backprops to every query holding the id, in one `batch`. `patch` is a `Partial<T>` merged per `merge` (`'shallow'` by default, or `'deep'`), or an updater `(prev) => next`. A missing entity warns in development and is a no-op. |
| `store.remove(entity, id)` | `void` | Drops the id from the store and the reverse index. It touches no query (`index.ts:917-930`). 1.0 renamed it from `invalidate`. |
| `store.list(entity, { filter? })` | `ReadSignal<T[]>` | Every stored entity of one type, re-derived when a slot for that type changes (`index.ts:963-987`). |
| `store.entries(entity)` | `ReadonlyMap<string, T>` | Devtools snapshot. A fresh `Map` with shallow-cloned, frozen values (`index.ts:932-961`). |
| `store.bindings(entity, id)` | `readonly EntityBinding[]` | Devtools view of the reverse index for one id. Frozen copies; `[]` for an id no query holds (`index.ts:989-1011`). |

## How auto-walk works

The plugin's `onWrite` observes every write of either query kind, whatever its source, except writes whose `origin` is its own name (`index.ts:388-398`). It walks the entry's **current** data, `queries.peek(id, key)`, and falls back to `event.data` only when the engine cannot find the entry. A plugin earlier in the list can write the entry again, or call `update`, before this hook sees the event. Walking the older `event.data` then put stale entities back into the store. Pinned by "a patch made before the plugin walked a reorder lands on the entity, not its old index", which fails on the store assertion with `event.data`.

For each walk, `observe` (`index.ts:663-721`):

1. Drops the reverse-index bindings the previous walk of that entry recorded. It rebuilds rather than diffs, bounded by the size of the query.
2. Walks the data. For each reachable object or array, `claim` runs every registered entity's `idOf` (`index.ts:675-692`). A non-null id means the node is that entity.
3. Records a binding `(queryId, keyArgs, path)` and writes the node into the entity's slot. With `isCanonical` set, a node that fails it gets the binding but no store write (`index.ts:690`), so a stub like `{ id: '1' }` cannot overwrite the full record.

For an infinite query, the data is the pages array, and the walker's array branch records `[pageIndex, …pathInPage]`.

### Path accumulator

The walker reuses **one mutable `Array<string | number>`** for the whole traversal, a local of `observe`. It pushes on descent and pops on ascent. `addBinding` clones it with `.slice()` (`index.ts:584-605`), so allocation happens only per recorded binding.

### Cycles and shared references: each object is descended into once

`walk` (`index.ts:695-715`) keeps two sets per walk:

- **`inProgress`**, the objects on the current descent path. Reaching one again is a cycle (`post.self = post`). The walk returns with no claim, so a self-loop binds once, at `[]`.
- **`walked`**, the objects already descended into. Reaching one again is a shared reference, such as one `Post` object at `posts[3]` and at `pinned`. The walk claims the node at this path too, then returns without descending.

So a shared entity gets one binding path per reference into it. An entity nested inside a shared object is bound at the path the walk first reached it by. The cost is one `idOf` call per registered entity for each object and each reference to it, linear in the data.

Until 1.0 the walk removed a node from its guard on exit and descended into a shared object once per path. A chain of diamonds, each level pointing at the next through two keys, has 2^depth paths to its bottom, and the walk took that long. The cost comment claimed it was linear (0.9 review). Pinned by "a chain of diamonds is walked and patched in linear time, and stays shared": at depth 16 the old walk made 131,071 `idOf` calls, and the test allows 33.

## How backprop works

`update(Post, id, patch)` (`index.ts:823-915`) does this inside one `batch`:

1. Reads the current value from the partition without allocating a slot. A missing one warns in development and returns.
2. Computes `next` from the updater, a deep merge, or a shallow spread.
3. Writes `next` into the slot.
4. For each entry the reverse index lists, reads the entry's current data with `queries.peek` and rebuilds it with `replaceEntity` (`index.ts:757-797`), which replaces every node `idOf` claims as `id` with `next`.
5. Writes the rebuilt data with `host.queries.write` (`index.ts:894`) and re-walks the entry (`index.ts:900`). A nested entity the patch brought in is normalized, and the entry's bindings follow the patch.
6. With no bindings at all, `absorbNested` stores the nested entities of `next` (`index.ts:728-741`), since no query walk will reach them.

`replaceEntity` is memoized per object. It calls `idOf` once per reachable object, rebuilds a shared object once, and keeps it shared. It keeps every unchanged subtree by reference and returns the root itself when nothing changed. A cycle back to an ancestor keeps pointing at the original object. It writes a changed key with `defineOwn`, an `Object.defineProperty` call (`index.ts:185-187`), so an own `__proto__` key in query data stays data.

Two outcomes skip the write:
- **The entry no longer holds the entity.** `update` counts it as `stale`, re-walks the entry through `observe` to drop the binding, and writes nothing (`index.ts:883-889`).
- **The rebuild changed nothing,** as with an updater that returns the stored value (`index.ts:891`).

### Why backprop does not follow the recorded paths (1.0)

Until 1.0, step 4 applied `setAtPath(prev, path, next)` for every recorded path, and a path that no longer led anywhere was a silent no-op (0.9 review). Since `update` re-walks what it writes, a path goes stale only when another plugin changes an entry before this plugin walks it. That happens in two ways:

- A plugin earlier in the list calls `update` from its `onWrite`, for a write this plugin has not walked yet.
- A plugin reacting to a backprop write rewrites another entry that the same `update` has not reached yet. The bindings snapshot then holds that entry's old paths.

The old path was worse than a no-op when something else had taken its place. A reorder of `[p1, p2]` to `[p2, p1]` put p1's patch over p2. The removal of p1 put it over whatever moved to index 0. `coverage-store-edges.test.ts`, "update patches each entry as it is now", pins the reorder, the removal and the rewrite-mid-update case. It also pins the cycle, and the identity updater that writes nothing. Each of the three stale-path tests fails on the old code.

The recorded paths remain, for `bindings()` and the devtools.

## How backprop avoids loops

The host stamps each backprop write with `origin: 'olas-entities'`, so the plugin's own `onWrite` skips it, and the re-walk in step 5 stands in for that walk. The re-walk writes nothing back to the cache, so it cannot loop. The rebuild shares untouched subtrees, so the re-walk sets sibling slots to the value they already hold, and `@preact/signals-core`'s `Object.is` check makes those writes silent.

`host.queries.write` is a canonical patch: no snapshot, and an in-flight fetch is left alone. It writes nothing for an entry the root no longer holds.

## Devtools lane

After each `update`, a development build calls `host.debug` with the fan-out (`index.ts:905-914`):

```ts nocheck
{ kind: 'update', entity: 'Post', id: 'p1', entries: 2, stale: 0, queries: ['feed', 'profile'] }
```

`entries` counts the entries the patch was written into, and `queries` names their query ids, one per entry. `stale` counts the entries the reverse index listed that no longer held the entity. An update with no binding reports `entries: 0`. A walk reports nothing, and neither does an update of a missing entity, which warns instead. The call sits in `if (__DEV__)`, so the default build strips it. `host.debug` is a no-op in core's default build too (`packages/core/src/plugin/host.ts:166-169`). Pinned by `tests/devtools-lane.test.ts`.

The package ships a `development` build for this (`packages/entities/tsdown.config.ts`, `../decisions/esm-only-build.md`).

## What the plugin uses from the host

- `onWrite` feeds the walker, and `onRemove` drops the removed entry's bindings (`index.ts:388-405`).
- `host.queries.peek` reads each entry's current data for the walk and for backprop, and `host.queries.write` carries backprop.
- `host.queries.hashKey` builds the binding key, `${queryId}\u0000${hashKey(keyArgs)}` (`index.ts:628-629`). It is the engine's own hash, so a binding collides with the cache entry it points at exactly when the same key would. Date values hash to ISO strings and object keys sort.
- `host.provide(Entities, store)` exposes the store, and the hook `dispose` clears it.
- `host.debug` carries the lane event.

## Constraints

- **Regular and infinite queries are both walked**, and backprop reaches both through `host.queries.write`, which keeps an infinite entry's `pageParams` aligned.
- **A backprop does not cross tabs by default.** `crossTabPlugin` mirrors only origin-`undefined` writes, so an `update` stays in its tab unless cross-tab's `origins` lists `ENTITIES_PLUGIN_NAME`. `cross-tab.md` records why that default stays.
- **The entity must be registered.** Every store method calls `assertRegistered` (`index.ts:467-485`) and throws for an `EntityDef` the plugin was not given. That catches the mistake at the call site instead of leaking orphan signals.
- **`update` defaults to a shallow merge.** The updater form covers anything else.
- **No `update` without a stored value.** There is nothing to patch onto. Development builds warn, and production builds return.
- **An `update` reaches the entries the reverse index lists when it starts.** An entry that gains the entity during the update, through another plugin's write, is not patched.

## Memory model

- Per-id signals live in a `Map<entityName, Map<id, Signal>>` (`index.ts:428`) until the plugin's `dispose` clears the whole map (`index.ts:1014-1022`).
- `dispose()` also sets a `disposed` flag, and `assertRegistered` checks it first. An emptied store and a never-registered entity look the same to a `store.get(name)` probe. Without the flag, every call after dispose reported `entity "X" was not registered…` and sent the reader after a registration that was there all along (0.9 review). Pinned by "calling into the store after dispose says it was disposed, not unregistered".
- The reverse index follows the cache. On `onRemove`, the plugin drops the removed entry's bindings and keeps the entity's slot, so a detail view subscribed to that entity keeps working after its source query is collected.
- Orphan slots accumulate over the app's lifetime. `defineEntity({ maxSlots })` caps a partition: on overflow, `getSlot` evicts orphans, meaning slots with no live bindings, in LRU order (`index.ts:486-562`). It never evicts a bound slot, so a cap below the bound count is exceeded without a warning. A partition without a cap warns once in development at `SLOT_BLOAT_WARN_AT`, 10,000 ids (`index.ts:165`).

## Tests

`packages/entities/tests/entities.test.ts` covers:

- `defineEntity` branding and `idOf`, duplicate-name rejection, and one store per root;
- auto-walk from a fetch, per-id signal observation, explicit `upsert`, and SSR-hydrated data reaching the store;
- `update` against one query, several queries, several paths in one query, and infinite-query pages;
- one subscriber notification per affected query per `update`;
- bindings dropped when an entity leaves a query, and `remove` touching no query;
- cycles, the shared-reference DAG, the chain of diamonds, and non-entity objects with an `id` field;
- unregistered entities, calls after dispose, a `Date` in the key, the updater form, `merge: 'deep'`, `entries()` and `bindings()` snapshots, and `maxSlots` eviction;
- nested entities a patch brings in, with and without a query holding the entity.

"reverse index drops bindings when an entity disappears from a query" was vacuous until 1.0 (0.9 review). It never read the reverse index, so it passed with a plugin that recorded no bindings at all. It now checks the binding exists first, that it is gone after the write, and that the `update` writes no query. It fails when `addBinding` records nothing and when `removeBindingsForKey` drops nothing.

`coverage-store-edges.test.ts` covers `list()`, `isCanonical`, reverse-index maintenance across queries and gc, the setup guard, the bloat warning, a nested entity its parent entity dropped, and the stale-binding cases above. `merge-security.test.ts` covers the `__proto__` cases below. `devtools-lane.test.ts` covers the lane. `packages/integration/tests/cross-tab-entities.test.ts` covers the plugin with cross-tab.

## Deep merge and prototype keys (1.0)

`deepMerge` reads the current value with `Object.hasOwn` and writes each key with `defineOwn`, an `Object.defineProperty` call (`index.ts:198-210`). A patch parsed from JSON can carry an own `__proto__` key. An assignment `out[key] = v` with that key replaced the merged entity's prototype, and the read `current[key]` returned `Object.prototype` as if it were a plain object to merge into. The backprop rebuild writes the same way. Pinned by `tests/merge-security.test.ts`; the bug class is `../pitfalls/proto-key-assignment.md`.

## Where to read next

- `packages/entities/src/index.ts` — the whole package.
- SPEC §18.1 — the worked example this package replaces.
- `query.md` — the write methods and the fetch lifecycle.
- `cross-tab.md` — the sibling plugin, and whose writes cross.
