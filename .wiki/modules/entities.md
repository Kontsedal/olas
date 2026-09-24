---
name: entities
description: "@kontsedal/olas-entities — entity normalization as an OlasPlugin: auto-walk on every write, a reverse index, backprop through host.queries.write, and the store as the Entities scope service."
type: module
covers:
  - packages/entities/src/index.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: documented-in, target: ../../BACKLOG.md }
  - { type: tested-by, target: ../../packages/entities/tests/entities.test.ts }
  - { type: tested-by, target: ../../packages/entities/tests/coverage-store-edges.test.ts }
  - { type: tested-by, target: ../../packages/entities/tests/merge-security.test.ts }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: query.md }
  - { type: uses, target: signals.md }
  - { type: related, target: cross-tab.md }
last_verified: 2026-09-25
confidence: high
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
| `defineEntity<T>` | `({ name, idOf, isCanonical?, maxSlots? }) => EntityDef<T>` | Module scope. `idOf(value)` returns the id when the value is this entity, else `null` or `undefined` (`packages/entities/src/index.ts:111-121`). |
| `entitiesPlugin` | `({ entities }) => OlasPlugin` | A duplicate `name` throws when `entitiesPlugin` is called (`index.ts:337-346`). The value is a definition: each root it is installed in gets its own store. `setup` throws without a query engine (`index.ts:350-356`). |
| `Entities` | `Scope<EntityStore>` | `setup` provides the store under it (`index.ts:302`, `index.ts:357-358`). Read it with `ctx.inject(Entities)` or `root.inject(Entities)`. A test seeds a fake through `RootOptions.scopes`. |
| `ENTITIES_PLUGIN_NAME` | `'olas-entities'` | The plugin's name, and the `origin` of its backprop writes (`index.ts:295`). |
| `store.signal(entity, id)` | `ReadSignal<T \| undefined>` | Allocated on first call and stable after it. Throws for an entity the plugin was not given. |
| `store.get(entity, id)` | `T \| undefined` | Non-reactive. Allocates no slot (`index.ts:757-766`). |
| `store.upsert(entity, value)` | `void` | For sources no query carries, such as a WebSocket event. A value whose `idOf` is null is ignored. |
| `store.update(entity, id, patch, { merge? })` | `void` | Backprops to every query holding the id, in one `batch`. `patch` is a `Partial<T>` merged per `merge` (`'shallow'` by default, or `'deep'`), or an updater `(prev) => next`. A missing entity warns in development and is a no-op. |
| `store.remove(entity, id)` | `void` | Drops the id from the store and the reverse index. It touches no query (`index.ts:846-859`). 1.0 renamed it from `invalidate`. |
| `store.list(entity, { filter? })` | `ReadSignal<T[]>` | Every stored entity of one type, re-derived when a slot for that type changes (`index.ts:892-916`). |
| `store.entries(entity)` | `ReadonlyMap<string, T>` | Devtools snapshot. A fresh `Map` with shallow-cloned, frozen values (`index.ts:861-890`). |
| `store.bindings(entity, id)` | `readonly EntityBinding[]` | Devtools view of the reverse index for one id. Frozen copies; `[]` for an id no query holds (`index.ts:918-940`). |

## How auto-walk works

The plugin's `onWrite` observes every write of either query kind, whatever its source, except writes whose `origin` is its own name (`index.ts:360-364`). For each one, `observe` (`index.ts:679-696`):

1. Drops the reverse-index bindings the previous walk of that entry recorded. It rebuilds rather than diffs, bounded by the size of the query.
2. Walks `event.data`. For each reachable plain object or array, it runs every registered entity's `idOf`. A non-null id means the node is that entity.
3. Records a binding `(queryId, keyArgs, path)` and writes the node into the entity's slot. With `isCanonical` set, a node that fails it gets the binding but no store write (`index.ts:619-627`), so a stub like `{ id: '1' }` cannot overwrite the full record.

For an infinite query, `data` is the pages array, and the walker's array branch records `[pageIndex, …pathInPage]`.

### Path accumulator

The walker reuses **one mutable `Array<string | number>`** for the whole traversal. It pushes on descent and pops on ascent. `addBinding` clones it with `.slice()` (`index.ts:534-555`), so allocation happens only per recorded binding.

### Cycle vs DAG handling

The cycle guard is a `WeakSet` of objects **currently being descended into**, added on entry and removed on exit (`index.ts:594-669`). It detects cycles depth-first rather than marking nodes as visited:

- **True cycle** (`post.self = post`): the second descent finds the node in `inProgress` and returns.
- **Shared-reference DAG** (one `Post` object at `posts[3]` and at `pinned`): the second visit comes after the first has popped, so the walk records both bindings. A visited-ever set would have lost the second path and broken `update`'s backprop for it.

## How backprop avoids loops

`update(Post, id, patch)` (`index.ts:778-844`) does this inside one `batch`:

1. Reads the current value from the partition without allocating a slot. A missing one warns in development and returns.
2. Computes `next` from the updater, a deep merge, or a shallow spread.
3. Writes `next` into the slot.
4. For each binding, calls `host.queries.write(queryId, keyArgs, prev => setAtPath(prev, path, next))` for every recorded path (`index.ts:825-835`).
5. Re-walks that entry with `observe(queryId, keyArgs, queries.peek(queryId, keyArgs))` (`index.ts:840`). A nested entity the patch brought in is normalized, and the entry's bindings follow the patch.
6. With no bindings at all, `absorbNested` stores the nested entities of `next` (`index.ts:703-721`), since no query walk will reach them.

The host stamps each write with `origin: 'olas-entities'`, so the plugin's own `onWrite` skips it and step 5 stands in for that walk. The walk writes nothing back to the cache, so it cannot loop. `setAtPath` (`index.ts:732-749`) shares untouched siblings by reference, so the re-walk sets sibling slots to the value they already hold, and `@preact/signals-core`'s `Object.is` check makes those writes silent.

`host.queries.write` is a canonical patch: no snapshot, and an in-flight fetch is left alone. It writes nothing for an entry the root no longer holds.

## What the plugin uses from the host

- `onWrite` feeds the walker, and `onRemove` drops the removed entry's bindings (`index.ts:365-371`).
- `host.queries.write` and `peek` carry backprop and the re-walk.
- `host.queries.hashKey` builds the binding key, `${queryId}\u0000${hashKey(keyArgs)}` (`index.ts:676-677`). It is the engine's own hash, so a binding collides with the cache entry it points at exactly when the same key would. Date values hash to ISO strings and object keys sort.
- `host.provide(Entities, store)` exposes the store, and the hook `dispose` clears it.

## Constraints

- **Regular and infinite queries are both walked**, and backprop reaches both through `host.queries.write`, which keeps an infinite entry's `pageParams` aligned.
- **A backprop does not cross tabs by default.** `crossTabPlugin` mirrors only origin-`undefined` writes, so an `update` stays in its tab unless cross-tab's `origins` lists `ENTITIES_PLUGIN_NAME`. See `cross-tab.md`.
- **The entity must be registered.** Every store method calls `assertRegistered` (`index.ts:431-449`) and throws for an `EntityDef` the plugin was not given. That catches the mistake at the call site instead of leaking orphan signals.
- **`update` defaults to a shallow merge.** The updater form covers anything else.
- **No `update` without a stored value.** There is nothing to patch onto. Development builds warn, and production builds return.

## Memory model

- Per-id signals live in a `Map<entityName, Map<id, Signal>>` until the plugin disposes, which clears the whole map (`index.ts:943-951`).
- `dispose()` also sets a `disposed` flag, and `assertRegistered` checks it first. An emptied store and a never-registered entity look the same to a `store.get(name)` probe. Without the flag, every call after dispose reported `entity "X" was not registered…` and sent the reader after a registration that was there all along (0.9 review). Pinned by "calling into the store after dispose says it was disposed, not unregistered".
- The reverse index follows the cache. On `onRemove`, the plugin drops the removed entry's bindings and keeps the entity's slot, so a detail view subscribed to that entity keeps working after its source query is collected.
- Orphan slots accumulate over the app's lifetime. `defineEntity({ maxSlots })` caps a partition: on overflow, `getSlot` evicts orphans, meaning slots with no live bindings, in LRU order (`index.ts:460-526`). It never evicts a bound slot, so a cap below the bound count is exceeded without a warning. A partition without a cap warns once in development at `SLOT_BLOAT_WARN_AT`, 10,000 ids.

## Tests

`packages/entities/tests/entities.test.ts` covers:

- `defineEntity` branding and `idOf`, duplicate-name rejection, and one store per root;
- auto-walk from a fetch, per-id signal observation, explicit `upsert`, and SSR-hydrated data reaching the store;
- `update` against one query, several queries, several paths in one query, and infinite-query pages;
- one subscriber notification per affected query per `update`;
- bindings dropped when an entity leaves a query, and `remove` touching no query;
- cycles, the shared-reference DAG, and non-entity objects with an `id` field;
- unregistered entities, calls after dispose, a `Date` in the key, the updater form, `merge: 'deep'`, `entries()` and `bindings()` snapshots, and `maxSlots` eviction;
- nested entities a patch brings in, with and without a query holding the entity.

`coverage-store-edges.test.ts` covers `list()`, `isCanonical`, reverse-index maintenance across queries and gc, the setup guard, the bloat warning, and paths that no longer exist. `merge-security.test.ts` covers the `__proto__` case below.

## Deep merge and prototype keys (1.0)

`deepMerge` reads the current value with `Object.hasOwn` and writes each key with `Object.defineProperty` (`index.ts:177-190`). A patch parsed from JSON can carry an own `__proto__` key. An assignment `out[key] = v` with that key replaced the merged entity's prototype, and the read `current[key]` returned `Object.prototype` as if it were a plain object to merge into. Pinned by `tests/merge-security.test.ts`; the bug class is `../pitfalls/proto-key-assignment.md`.

## Where to read next

- `packages/entities/src/index.ts` — the whole package.
- SPEC §18.1 — the worked example this package replaces.
- `query.md` — the write methods and the fetch lifecycle.
- `cross-tab.md` — the sibling plugin, and whose writes cross.
