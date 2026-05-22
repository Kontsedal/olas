# @kontsedal/olas-entities

Entity-normalization plugin for Olas. Solves the cross-query update problem in [SPEC §18.1](../../SPEC.md): when the same `Post` / `User` lives in many independent queries, calling `entities.update(Post, id, patch)` patches every query holding that id in a single batched write.

Built on the [`QueryClientPlugin`](../../SPEC.md) surface (SPEC §13.2). Observes every cache write (fetch + setData + remote), walks the data via per-entity `idOf` predicates, and maintains a normalized store plus a reverse index of `(entity-id → queries-holding-it)`.

## Install

```bash
pnpm add @kontsedal/olas-entities @kontsedal/olas-core @preact/signals-core
```

## 60-second example

```ts
import { createRoot, defineController, defineQuery } from '@kontsedal/olas-core'
import { defineEntity, entitiesPlugin } from '@kontsedal/olas-entities'

type Post = { id: string; title: string; likes: number }
type User = { id: string; name: string }

// 1. Declare entity types — module scope.
const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v: any) => v?.id && typeof v.id === 'string' && 'title' in v ? v.id : null,
})
const User = defineEntity<User>({
  name: 'User',
  idOf: (v: any) => v?.id && typeof v.id === 'string' && 'name' in v ? v.id : null,
})

// 2. Define queries normally — they don't need to know about entities.
const feedQuery = defineQuery({
  queryId: 'feed',
  key: () => [],
  fetcher: async () => (await fetch('/feed')).json() as Promise<{ posts: Post[] }>,
})
const profileQuery = defineQuery({
  queryId: 'profile',
  key: (id: string) => [id],
  fetcher: async (_ctx, id: string) =>
    (await fetch(`/users/${id}`)).json() as Promise<{ user: User; latestPosts: Post[] }>,
})

// 3. Install the plugin at the root.
const entities = entitiesPlugin([Post, User])
const root = createRoot(appController, {
  deps: {},
  plugins: [entities],
})

// 4. Read normalized entities reactively in components.
//    (entities.signal(Post, id) → ReadSignal<Post | undefined>)
const post = use(entities.signal(Post, 'p1'))

// 5. Patch once — every query gets the update.
entities.update(Post, 'p1', { likes: 99 })
//    feedQuery.data.posts: the Post at index N is now { ..., likes: 99 }
//    profileQuery.data.latestPosts: the Post is updated too
//    entities.signal(Post, 'p1') fires once
//    one render across the affected queries (writes wrapped in `batch`).
```

## API

```ts
function defineEntity<T>(opts: {
  name: string
  idOf: (value: T) => string | null | undefined
}): EntityDef<T>

function entitiesPlugin(entities: EntityDef<unknown>[]): EntitiesPlugin

type EntitiesPlugin = QueryClientPlugin & {
  signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined>
  get<T>(entity: EntityDef<T>, id: string): T | undefined
  upsert<T>(entity: EntityDef<T>, value: T): void
  update<T extends object>(
    entity: EntityDef<T>,
    id: string,
    patch: Partial<T> | ((prev: T) => T),
  ): void
  invalidate<T>(entity: EntityDef<T>, id: string): void
  // Devtools / debugging — non-reactive snapshots.
  entries<T>(entity: EntityDef<T>): ReadonlyMap<string, T>
  bindings<T>(entity: EntityDef<T>, id: string): ReadonlyArray<EntityBinding>
}
```

| Method | What |
|---|---|
| `defineEntity` | Module-scope entity descriptor. `idOf` should include a discriminating field check so unrelated objects with an `id` field aren't classified. |
| `entitiesPlugin([...])` | Register entities on a root via `RootOptions.plugins[]`. One instance per root — reuse throws via `onError`. Duplicate `name`s throw at construction. |
| `entities.signal(Post, id)` | Per-id `ReadSignal`. Stable across calls (interned). Subscribe via `@kontsedal/olas-react` `use(...)`. Throws if `Post` wasn't passed to `entitiesPlugin([...])`. |
| `entities.get(Post, id)` | Non-reactive read. Same registration check. |
| `entities.upsert(Post, raw)` | Explicit branding for non-query sources (WebSocket events, preloads). |
| `entities.update(Post, id, patchOrUpdater)` | Shallow-merge `Partial<T>` OR `(prev: T) => T`. Backpropagates to every query, batched. Warns in dev when the entity isn't in the store (no-op in prod). |
| `entities.invalidate(Post, id)` | Remove from store. Does NOT touch queries. |
| `entities.entries(Post)` | Returns a fresh `Map<id, Post>` snapshot of the store. Mutating it does NOT affect the live store. |
| `entities.bindings(Post, id)` | Returns the reverse-index entries `[{ queryId, keyArgs, paths }]` for that id. Deep-cloned; safe to mutate. Empty array when the entity isn't held by any query. |

## How it works

The plugin observes every `SetDataEvent` (sources: `'fetch' | 'set' | 'remote'`). For each event with `kind: 'data'`:

1. Drops the previous reverse-index bindings for that `(queryId, keyArgs)`.
2. Recursively walks `event.data`. For each subtree node, runs every registered entity's `idOf`. A non-null id means it's an entity.
3. Upserts the entity into the per-id signal AND records the path under the binding.

On `entities.update(Post, id, patch)`:

1. Compute `next = { ...current, ...patch }`.
2. Write `next` into the entity slot.
3. For each (queryId, keyArgs, paths) binding in the reverse index, call the new `QueryClientPluginApi.setEntryData` with an immutable patch at every path. All writes happen inside one `batch(...)` — subscribers see one notification per affected query, not one per path.

The post-update walk that runs when the patch's `setEntryData` fires its `SetDataEvent` is dedup'd by `@preact/signals-core`'s `Object.is` equality — the slot already holds `next`, so re-setting it is a no-op and the loop terminates after one cycle.

## Constraints (v1)

- **Regular and infinite queries are both walked.** Infinite payloads (`kind: 'infinite'`) traverse the `TPage[]` shape transparently — the walker's existing array branch handles page indices, and `setEntryData` routes infinite-keyed writes back through `InfiniteEntry.setData`. Cross-tab still skips infinite (different concern: payload size).
- **One plugin instance per root.** Construct a fresh `entitiesPlugin([...])` per `createRoot(...)`.
- **Entity must be registered.** `signal / get / upsert / update / invalidate / entries / bindings` throw when called with an `EntityDef` that wasn't passed to `entitiesPlugin([...])`. Catches the mistake at the call site instead of leaking orphan signals.
- **`update` default is shallow-merge.** Use the function form (`update(id, prev => ...)`) for non-shallow / computed updates.
- **`update` is a no-op if the entity isn't in the store.** Warns in dev. Use `upsert` first if you want create-or-patch semantics.

## Memory characteristics

- **Per-id signal slots are allocated on first read** of `entities.signal(Post, id)` (or first observation in a query). They live until the plugin is disposed. If your app calls `signal(Post, dynamicId)` with churning ids (e.g., per-render computed values), the slot map grows unbounded — dev builds emit a one-shot warning once any entity partition crosses 10k unique ids. Per-entity LRU eviction is on the BACKLOG.
- **Walk cost is O(reachable nodes)** per `SetDataEvent`. The walker uses one mutable path accumulator (push/pop on descent/ascent) and clones only at binding boundaries.
- **Shared-reference DAGs** are handled correctly: a single `Post` reachable via two paths gets bindings recorded for both. True cycles (a `Post` referencing itself) short-circuit on the second descent.

## Interaction with `@kontsedal/olas-cross-tab`

Both plugins observe `SetDataEvent`s. Cross-tab broadcasts `source: 'set'` events but skips `source: 'fetch'` (every tab runs its own fetcher). When `entities.update` calls `setEntryData`, the resulting event has `source: 'set'` and IS broadcast — entity patches propagate across tabs.

## What's NOT included

- Cross-tab broadcast of infinite-query updates (the entities plugin walks infinite locally; `@kontsedal/olas-cross-tab` still skips `kind: 'infinite'` for payload-size reasons).
- Deep-merge semantics on `update` are off by default — pass `{ merge: 'deep' }` (or use the function form) when you need them.
- `entity.subscribe(id)` outside React — use `entities.signal(Post, id).subscribe(handler)` directly.

Tracked in [`../../BACKLOG.md`](../../BACKLOG.md).

## Further reading

- [`../../.wiki/modules/entities.md`](../../.wiki/modules/entities.md)
- [SPEC §18.1](../../SPEC.md) — the worked example this package replaces.
- [SPEC §13.2](../../SPEC.md) — `QueryClientPlugin` contract.
