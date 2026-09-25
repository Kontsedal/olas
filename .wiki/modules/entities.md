---
name: entities
description: "@kontsedal/olas-entities — entity normalization as an OlasPlugin: a linear auto-walk of each entry's current data on every write, a reverse index, backprop that finds the entity in the entry as it is now, the store as the Entities scope service, and a devtools lane."
type: module
covers:
  - packages/entities/src/index.ts
  - packages/entities/tsdown.config.ts
  - packages/entities/scripts/dts-export-marker.ts
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
  - { type: tested-by, target: ../../packages/entities/tests/optimistic-backprop.test.ts }
  - { type: tested-by, target: ../../packages/integration/tests/optimistic-cross-tab.test.ts }
  - { type: related, target: ../pitfalls/visible-data-is-not-a-baseline.md }
  - { type: tested-by, target: ../../packages/integration/tests/cross-tab-entities.test.ts }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: query.md }
  - { type: uses, target: signals.md }
  - { type: related, target: cross-tab.md }
  - { type: related, target: devtools-panel.md }
  - { type: related, target: ../pitfalls/dts-export-context.md }
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
| `defineEntity<T>` | `({ name, idOf, isCanonical?, maxSlots? }) => EntityDef<T>` | Module scope. `idOf(value)` returns the id when the value is this entity, else `null` or `undefined` (`packages/entities/src/index.ts:88-91`). |
| `entitiesPlugin` | `({ entities }) => OlasPlugin` | A duplicate `name` throws when `entitiesPlugin` is called (`index.ts:413-424`). The value is a definition: each root it is installed in gets its own store. `setup` throws without a query engine (`index.ts:427-434`). |
| `Entities` | `Scope<EntityStore>` | `setup` provides the store under it (`index.ts:378`, `index.ts:435-438`). Read it with `ctx.inject(Entities)` or `root.inject(Entities)`. A test seeds a fake through `RootOptions.scopes`. |
| `ENTITIES_PLUGIN_NAME` | `'olas-entities'` | The plugin's name, and the `origin` of its backprop writes (`index.ts:371`). |
| `store.signal(entity, id)` | `ReadSignal<T \| undefined>` | A read of the id's slot, the same handle for as long as anything holds it (`handleFor`, `index.ts:936-976`). It survives `remove` and eviction. Throws for an entity the plugin was not given. |
| `store.get(entity, id)` | `T \| undefined` | Non-reactive. Allocates no slot (`index.ts:987-996`). |
| `store.upsert(entity, value)` | `void` | For sources no query carries, such as a WebSocket event. A value whose `idOf` is null is ignored. |
| `store.update(entity, id, patch, { merge? })` | `void` | Backprops to every query holding the id, in one `batch`. `patch` is a `Partial<T>` merged per `merge` (`'shallow'` by default, or `'deep'`), or an updater `(prev) => next`. A missing entity warns in development and is a no-op. |
| `store.remove(entity, id)` | `void` | Drops the id from the store and the reverse index. It touches no query (`index.ts:1109-1123`). A handle reads `undefined`, then follows the entity again when it returns. 1.0 renamed it from `invalidate`. |
| `store.list(entity, { filter? })` | `ReadSignal<T[]>` | Every stored entity of one type, re-derived when a slot for that type changes (`index.ts:1156-1180`). |
| `store.entries(entity)` | `ReadonlyMap<string, T>` | Devtools snapshot. A fresh `Map` with shallow-cloned, frozen values (`index.ts:1125-1154`). |
| `store.bindings(entity, id)` | `readonly EntityBinding[]` | Devtools view of the reverse index for one id. Frozen copies; `[]` for an id no query holds (`index.ts:1182-1204`). |

## How auto-walk works

The plugin's `onWrite` observes every write of either query kind, whatever its source, except writes whose `origin` is its own name (`index.ts:440-450`). It walks the entry's **current** data, `queries.peek(id, key)`, and falls back to `event.data` only when the engine cannot find the entry. A plugin earlier in the list can write the entry again, or call `update`, before this hook sees the event. Walking the older `event.data` then put stale entities back into the store. Pinned by "a patch made before the plugin walked a reorder lands on the entity, not its old index", which fails on the store assertion with `event.data`.

For each walk, `observe` (`index.ts:746-804`):

1. Drops the reverse-index bindings the previous walk of that entry recorded. It rebuilds rather than diffs, bounded by the size of the query.
2. Walks the data. For each reachable object or array, `claim` runs every registered entity's `idOf` (`index.ts:758-775`). A non-null id means the node is that entity.
3. Records a binding `(queryId, keyArgs, path)` and writes the node into the entity's slot. With `isCanonical` set, a node that fails it gets the binding but no store write (`index.ts:773`), so a stub like `{ id: '1' }` cannot overwrite the full record.

For an infinite query, the data is the pages array, and the walker's array branch records `[pageIndex, …pathInPage]`.

### Path accumulator

The walker reuses **one mutable `Array<string | number>`** for the whole traversal, a local of `observe`. It pushes on descent and pops on ascent. `addBinding` clones it with `.slice()` (`index.ts:667-688`), so allocation happens only per recorded binding.

### Cycles and shared references: each object is descended into once

`walk` (`index.ts:778-798`) keeps two sets per walk:

- **`inProgress`**, the objects on the current descent path. Reaching one again is a cycle (`post.self = post`). The walk returns with no claim, so a self-loop binds once, at `[]`.
- **`walked`**, the objects already descended into. Reaching one again is a shared reference, such as one `Post` object at `posts[3]` and at `pinned`. The walk claims the node at this path too, then returns without descending.

So a shared entity gets one binding path per reference into it. An entity nested inside a shared object is bound at the path the walk first reached it by. The cost is one `idOf` call per registered entity for each object and each reference to it, linear in the data.

Until 1.0 the walk removed a node from its guard on exit and descended into a shared object once per path. A chain of diamonds, each level pointing at the next through two keys, has 2^depth paths to its bottom, and the walk took that long. The cost comment claimed it was linear (0.9 review). Pinned by "a chain of diamonds is walked and patched in linear time, and stays shared": at depth 16 the old walk made 131,071 `idOf` calls, and the test allows 33.

## How backprop works

`update(Post, id, patch)` (`index.ts:1005-1107`) does this inside one `batch`:

1. Reads the current value from the partition without allocating a slot. A missing one warns in development and returns.
2. Builds `apply`, the patch as a function of one copy of the entity: the updater, a deep merge, or a shallow merge. `next` is `apply` of the store's value.
3. Writes `next` into the slot.
4. For each entry the reverse index lists, reads the entry's current data with `queries.peek` and rebuilds it with `replaceEntity` (`index.ts:871-926`). Every node `idOf` claims as `id` gets one record: `apply` of the entity's first canonical copy in that data, or of `next` when the data holds only stubs (`canonicalIn`, `index.ts:831-848`).
5. Writes it with `host.queries.write` as a patch (`index.ts:1084-1086`), and re-walks the entry (`index.ts:1092`). The engine re-runs the updater on each live optimistic baseline (SPEC §6.4), where `replaceEntity` patches the entity as that baseline holds it. A nested entity the patch brought in is normalized, and the entry's bindings follow the patch.
6. With no bindings at all, `absorbNested` stores the nested entities of `next` (`index.ts:811-824`), since no query walk will reach them.

`replaceEntity` is memoized per object. It calls `idOf` once per reachable object, rebuilds a shared object once, and keeps it shared. It keeps every unchanged subtree by reference and returns the root itself when nothing changed. A cycle back to an ancestor keeps pointing at the original object. It writes a changed key with `defineOwn`, an `Object.defineProperty` call (`index.ts:206-208`), so an own `__proto__` key in query data stays data. It rebuilds an object with `copyRecord` (`index.ts:217-221`), which keeps the prototype; see "Backprop keeps prototypes" below.

Two outcomes skip the write:
- **The entry no longer holds the entity.** `update` counts it as `stale`, re-walks the entry through `observe` to drop the binding, and writes nothing (`index.ts:1070-1076`).
- **The rebuild changed nothing,** as with an updater that returns the stored value (`index.ts:1078`).

### Why backprop does not follow the recorded paths (1.0)

Until 1.0, step 4 applied `setAtPath(prev, path, next)` for every recorded path, and a path that no longer led anywhere was a silent no-op (0.9 review). Since `update` re-walks what it writes, a path goes stale only when another plugin changes an entry before this plugin walks it. That happens in two ways:

- A plugin earlier in the list calls `update` from its `onWrite`, for a write this plugin has not walked yet.
- A plugin reacting to a backprop write rewrites another entry that the same `update` has not reached yet. The bindings snapshot then holds that entry's old paths.

The old path was worse than a no-op when something else had taken its place. A reorder of `[p1, p2]` to `[p2, p1]` put p1's patch over p2. The removal of p1 put it over whatever moved to index 0. `coverage-store-edges.test.ts`, "update patches each entry as it is now", pins the reorder, the removal and the rewrite-mid-update case. It also pins the cycle, and the identity updater that writes nothing. Each of the three stale-path tests fails on the old code.

The recorded paths remain, for `bindings()` and the devtools.

## Backprop under a live guess (third 1.0 review)

The store follows the data on screen: `onWrite` walks every source, an `'optimistic'` one included, so `entities.signal(Post, id)` shows a pending like. Until the third 1.0 review `update` wrote `next`, computed from that store, into every entry as a whole value. With a like pending on the feed and a push renaming the post, `next` carried the like. The detail query, which never showed the like, got it canonically. The feed's baseline got it too, because core now re-runs a canonical write on each live baseline (Q1 in `../pitfalls/visible-data-is-not-a-baseline.md`), and `() => next` returns `next` on every one. When the like failed, the rollback restored `{ title: 'Renamed', likes: 1 }` and the detail kept `likes: 1`.

`update` now writes a patch of each entry's own copy, and core re-runs it on each baseline. The choices:

- **Patch per copy, not the store's value.** The store holds a guess whenever a query shows one, so a value built from it is a guess. Each copy gets the change the caller asked for and keeps whatever else it held, guesses included where they already were.
- **One record per entry, from its first canonical copy.** The old code replaced every copy in an entry with one `next`, and a test pins that two copies end as one reference. Patching the first canonical copy keeps that, and a stub gets the whole patched record as before. The search for a canonical copy runs only when the first copy met is a stub. That keeps the patch linear ("a chain of diamonds" pins the `idOf` count).
- **The store keeps walking every source.** A walk of a `'rollback'` or a `'commit'` re-walks the entry, so once every layer has settled the store holds settled data. Skipping guesses in the walk was the other option. It would have taken the pending like out of `entities.signal`, which views read.
- **An updater runs more than once:** once for the store, once per entry, and once per live baseline. It has to be pure, and the `update` doc says so.

Pinned by `tests/optimistic-backprop.test.ts`: a failed like with a rename in between, a committed like, and an updater patch on each copy and baseline. The first and third failed on the new core before this change. `packages/integration/tests/optimistic-cross-tab.test.ts` runs the store against a guess another tab mirrored.

## Backprop keeps prototypes (third 1.0 review)

`replaceEntity` rebuilt each object on the path to the entity with `{ ...record }`, and a shallow `update` rebuilt the entity with `{ ...current, ...patch }`. A spread returns a plain object, so a fetcher's `new Page([...])` lost `hasMore()`, and a null-prototype object gained `Object.prototype`. `copyRecord` (`index.ts:217-221`) creates the copy with `Object.create(Object.getPrototypeOf(record))` and writes each own enumerable key with `defineOwn`, so an own `__proto__` key stays data (`../pitfalls/proto-key-assignment.md`). `shallowMerge` (`index.ts:224-228`) and `deepMerge` build on it. Private fields and non-enumerable properties are not copied, so a class whose methods read `#private` state still breaks. Pinned by the two "keeps prototypes" tests in `tests/optimistic-backprop.test.ts`, which failed on the old code.

## How backprop avoids loops

The host stamps each backprop write with `origin: 'olas-entities'`, so the plugin's own `onWrite` skips it, and the re-walk in step 5 stands in for that walk. The re-walk writes nothing back to the cache, so it cannot loop. The rebuild shares untouched subtrees, so the re-walk sets sibling slots to the value they already hold, and `@preact/signals-core`'s `Object.is` check makes those writes silent.

`host.queries.write` is a canonical patch: no snapshot, and an in-flight fetch is left alone. Core re-runs its updater on each live optimistic baseline. It writes nothing for an entry the root no longer holds.

## Devtools lane

After each `update`, a development build calls `host.debug` with the fan-out (`index.ts:1097-1106`):

```ts nocheck
{ kind: 'update', entity: 'Post', id: 'p1', entries: 2, stale: 0, queries: ['feed', 'profile'] }
```

`entries` counts the entries the patch was written into, and `queries` names their query ids, one per entry. `stale` counts the entries the reverse index listed that no longer held the entity. An update with no binding reports `entries: 0`. A walk reports nothing, and neither does an update of a missing entity, which warns instead. The call sits in `if (__DEV__)`, so the default build strips it. `host.debug` is a no-op in core's default build too (`packages/core/src/plugin/host.ts:166-169`). Pinned by `tests/devtools-lane.test.ts`.

The package ships a `development` build for this (`packages/entities/tsdown.config.ts`, `../decisions/esm-only-build.md`). Its declaration build runs `scripts/dts-export-marker.ts`, which keeps the private `BRAND` and `PHANTOM` symbols out of the published types (`../pitfalls/dts-export-context.md`).

## What the plugin uses from the host

- `onWrite` feeds the walker, and `onRemove` drops the removed entry's bindings (`index.ts:440-457`).
- `host.queries.peek` reads each entry's current data for the walk and for backprop, and `host.queries.write` carries backprop.
- `host.queries.hashKey` builds the binding key, `${queryId}\u0000${hashKey(keyArgs)}` (`index.ts:711-712`). It is the engine's own hash, so a binding collides with the cache entry it points at exactly when the same key would. Date values hash to ISO strings and object keys sort.
- `host.provide(Entities, store)` exposes the store, and the hook `dispose` clears it.
- `host.debug` carries the lane event.

## Constraints

- **Regular and infinite queries are both walked**, and backprop reaches both through `host.queries.write`, which keeps an infinite entry's `pageParams` aligned.
- **A backprop does not cross tabs by default.** `crossTabPlugin` mirrors only origin-`undefined` writes, so an `update` stays in its tab unless cross-tab's `origins` lists `ENTITIES_PLUGIN_NAME`. `cross-tab.md` records why that default stays.
- **The entity must be registered.** Every store method calls `assertRegistered` (`index.ts:548-566`) and throws for an `EntityDef` the plugin was not given. That catches the mistake at the call site instead of leaking orphan signals.
- **`update` defaults to a shallow merge.** The updater form covers anything else.
- **No `update` without a stored value.** There is nothing to patch onto. Development builds warn, and production builds return.
- **An `update` reaches the entries the reverse index lists when it starts.** An entry that gains the entity during the update, through another plugin's write, is not patched.

## Memory model

- Per-id slot signals live in a `Map<entityName, Map<id, Signal>>` (`index.ts:480`) until the plugin's `dispose` clears the whole map (`index.ts:1207-1216`). The slots are internal. `signal(entity, id)` hands out a handle that reads the slot, not the slot itself (see "Handles outlive their slots" below).
- `dispose()` also sets a `disposed` flag, and `assertRegistered` checks it first. An emptied store and a never-registered entity look the same to a `store.get(name)` probe. Without the flag, every call after dispose reported `entity "X" was not registered…` and sent the reader after a registration that was there all along (0.9 review). Pinned by "calling into the store after dispose says it was disposed, not unregistered".
- The reverse index follows the cache. On `onRemove`, the plugin drops the removed entry's bindings and keeps the entity's slot, so a detail view subscribed to that entity keeps working after its source query is collected.
- Orphan slots accumulate over the app's lifetime. `defineEntity({ maxSlots })` caps a partition: on overflow, `getSlot` calls `trimOrphans`, which evicts orphans in LRU order (`index.ts:568-645`). An orphan has no live bindings and no `subscribe` open on its handle (`isWatched`, `index.ts:499-500`). A bound or watched slot is never evicted, so a cap below that count is exceeded without a warning. A partition without a cap warns once in development at `SLOT_BLOAT_WARN_AT`, 10,000 ids (`index.ts:186`).

### Handles outlive their slots (1.0 review)

Until the review, `signal(entity, id)` returned the slot `Signal` itself, and both `remove` and `trimOrphans` set it to `undefined` and deleted it from the partition. A handle a view held was then stranded. The next walk or `upsert` of that id allocated a new slot, and the old handle stayed `undefined` for good. A fresh `signal()` call returned a different object, which broke the "stable across calls" promise. Two cases, each pinned by a test that failed on the old code:

- `signal(Post, 'p1')` subscribed, then `remove`, then a refetch of p1. Pinned by "a handle given out before remove follows the entity when it returns" in `coverage-store-edges.test.ts`.
- `maxSlots: 2`, a detail view subscribed to p1 after its query was collected (no bindings), then two more upserts. The eviction took p1 from under the view, against the `maxSlots` TSDoc's "subscribers keep working" and this page's gc claim above. Pinned by "maxSlots never evicts a slot a subscriber holds, even with no query binding it" in `entities.test.ts`.

The fix separates the handle from the slot:

- **The handle reads by id.** `handleFor` (`index.ts:936-976`) wraps a `computed` that looks the slot up in the partition on every evaluation. With no slot it reads `undefined` and tracks the entity's `arrivals` counter. `getSlot` bumps that counter whenever it allocates a slot, so the handle picks up the new slot when the entity returns. The handle is a plain `ReadSignal`, no longer the writable slot.
- **Leaving a slot notifies its readers.** `detach` (`index.ts:507-510`) deletes the slot from the partition first, then sets it to the `DETACHED` symbol (`index.ts:179`). The order matters: a handle re-evaluating during the set must already find no slot. The sentinel matters too: a slot that held `undefined`, such as one `signal()` allocated for an id never seen, would not notify on a set to `undefined`, and its readers would keep tracking a signal nothing writes again.
- **Handles are cached weakly.** `handles` maps each id to a `WeakRef` of its handle plus a `watchers` count, and a `FinalizationRegistry` drops the entry once the handle is collected, as core's `createSelection` does for `isSelected`. So identity holds for as long as anything holds the handle, and an id a view looked at once pins nothing. An open `subscribe` holds the handle too (see the next section). Only an unheld handle is ever replaced, which no caller can observe.
- **`subscribe` holds a slot; `.value` does not.** The handle's `subscribe` and `subscribeChanges` count into `watchers`, and `trimOrphans` skips a watched id. The framework adapters subscribe that way. A `computed` or `effect` that reads `.value` is invisible to the count, because core's `signal` exposes no watched callback. Eviction therefore reads as `undefined` through such a reader, and it follows the entity again when the entity returns.

What it costs: one `computed` and a small wrapper per handle, created on the first `signal()` call for an id. A handle whose slot is missing re-evaluates on each slot allocation of its entity type, and on nothing else.

### A subscription outlives its handle (second 1.0 review)

The `watchers` count lived on the handle's cache entry, and the `FinalizationRegistry` deleted that entry once the handle was collected. The unsubscribe closure held the entry and the inner `computed`, but not the handle. So `const off = entities.signal(Item, 'p1').subscribe(fn)`, which keeps only the unsubscribe, lost its count at the next collection. `trimOrphans` then evicted p1 under a live subscriber, and `fn` saw `undefined`, against SPEC §18.1.

The fix pins the handle while a subscription is open. `watch` sets `entry.held` to the handle on the first open `subscribe` and clears it on the last close (`index.ts:952-963`). It reads the handle through `entry.ref.deref()`. A closure that named `handle` would put it in the scope the returned unsubscribe keeps, so a caller holding a closed unsubscribe would pin the handle.

Pinned by "a subscription holds its slot after the caller drops the handle and it is collected" in `entities.test.ts`. The test gets a real `gc` at runtime: `v8.setFlagsFromString('--expose-gc')`, then `vm.runInNewContext('gc')`, both through `process.getBuiltinModule` because the package's types leave Node out. It collects between tasks, since a `WeakRef` keeps its target alive until the current task ends. Its first half failed on the old code. Its second half checks that the handle is collectable again after `off()`, and it fails when `watch` names `handle` directly.

## Tests

`packages/entities/tests/entities.test.ts` covers:

- `defineEntity` branding and `idOf`, duplicate-name rejection, and one store per root;
- auto-walk from a fetch, per-id signal observation, explicit `upsert`, and SSR-hydrated data reaching the store;
- `update` against one query, several queries, several paths in one query, and infinite-query pages;
- one subscriber notification per affected query per `update`;
- bindings dropped when an entity leaves a query, and `remove` touching no query;
- cycles, the shared-reference DAG, the chain of diamonds, and non-entity objects with an `id` field;
- unregistered entities, calls after dispose, a `Date` in the key, the updater form, `merge: 'deep'`, and the `entries()` and `bindings()` snapshots;
- `maxSlots` eviction, including a watched slot that eviction skips, one whose handle was collected, and a handle that comes back;
- nested entities a patch brings in, with and without a query holding the entity.

"reverse index drops bindings when an entity disappears from a query" was vacuous until 1.0 (0.9 review). It never read the reverse index, so it passed with a plugin that recorded no bindings at all. It now checks the binding exists first, that it is gone after the write, and that the `update` writes no query. It fails when `addBinding` records nothing and when `removeBindingsForKey` drops nothing.

`coverage-store-edges.test.ts` covers `list()`, `isCanonical`, reverse-index maintenance across queries and gc, the setup guard, the bloat warning, a nested entity its parent entity dropped, and the stale-binding cases above. `merge-security.test.ts` covers the `__proto__` cases below. `devtools-lane.test.ts` covers the lane. `packages/integration/tests/cross-tab-entities.test.ts` covers the plugin with cross-tab.

## Deep merge and prototype keys (1.0)

`deepMerge` reads the current value with `Object.hasOwn` and writes each key with `defineOwn`, an `Object.defineProperty` call (`index.ts:239-251`). A patch parsed from JSON can carry an own `__proto__` key. An assignment `out[key] = v` with that key replaced the merged entity's prototype, and the read `current[key]` returned `Object.prototype` as if it were a plain object to merge into. The backprop rebuild writes the same way. Pinned by `tests/merge-security.test.ts`; the bug class is `../pitfalls/proto-key-assignment.md`.

## Where to read next

- `packages/entities/src/index.ts` — the whole package.
- SPEC §18.1 — the worked example this package replaces.
- `query.md` — the write methods and the fetch lifecycle.
- `cross-tab.md` — the sibling plugin, and whose writes cross.
