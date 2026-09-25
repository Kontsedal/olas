# @kontsedal/olas-entities

**The same `Post` shows up in your feed query, your profile query, and a search result — then someone likes it.** Now three cache entries disagree and you're patching them by hand. `@kontsedal/olas-entities` collapses that to one call. `entities.update(Post, id, { likes })` patches *every* query holding that id in a single batched write, and each subscriber re-renders once.

It is an entity-normalization plugin on the Olas plugin host (SPEC §13). It observes every cache write, whether a fetch, a hydration, an optimistic or canonical write, or a write another tab sent. It walks the data with per-entity `idOf` predicates, and maintains a normalized store plus a reverse index from entity id to the queries holding it. Your queries never know it is there. SPEC §18.1 has the full worked problem it replaces.

## Install

```bash
pnpm add @kontsedal/olas-entities @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { defineEntity, Entities, entitiesPlugin } from '@kontsedal/olas-entities'

type Post = { id: string; title: string; likes: number }
type User = { id: string; name: string }

// 1. Declare entity types — module scope.
const Post = defineEntity<Post>({
  name: 'Post',
  idOf: (v: any) => (typeof v?.id === 'string' && 'title' in v ? v.id : null),
})
const User = defineEntity<User>({
  name: 'User',
  idOf: (v: any) => (typeof v?.id === 'string' && 'name' in v ? v.id : null),
})

// 2. Define queries normally — they don't need to know about entities.
const feedQuery = defineQuery({
  id: 'feed',
  key: () => [],
  fetcher: async () => (await fetch('/feed')).json() as Promise<{ posts: Post[] }>,
})
const profileQuery = defineQuery({
  id: 'profile',
  key: (id: string) => [id],
  fetcher: async (_ctx, id: string) =>
    (await fetch(`/users/${id}`)).json() as Promise<{ user: User; latestPosts: Post[] }>,
})

// 3. Reach the store from any controller.
const appController = defineController((ctx) => {
  const entities = ctx.inject(Entities)
  return {
    feed: createQuery(ctx, feedQuery),
    profile: createQuery(ctx, profileQuery, () => ['u1']),
    // ReadSignal<Post | undefined>. Read it with `useValue(...)` in React.
    post: entities.signal(Post, 'p1'),
    like: (id: string) => entities.update(Post, id, (p) => ({ ...p, likes: p.likes + 1 })),
  }
})

// 4. Install the plugin at the root.
const root = createRoot(appController, {
  queries: queryEngine(),
  deps: {},
  plugins: [entitiesPlugin({ entities: [Post, User] })],
})

// 5. Patch once — every query gets the update.
root.inject(Entities).update(Post, 'p1', { likes: 99 })
//    feed.data.posts: the Post at index N is now { ..., likes: 99 }
//    profile.data.latestPosts: the Post is updated too
//    post fires once
//    one render across the affected queries (writes wrapped in `batch`).
```

## API

```ts nocheck
function defineEntity<T>(opts: {
  name: string
  idOf: (value: T) => string | null | undefined
  isCanonical?: (value: T) => boolean
  maxSlots?: number
}): EntityDef<T>

function entitiesPlugin(options: { entities: ReadonlyArray<EntityDef<unknown>> }): OlasPlugin

const Entities: Scope<EntityStore>          // ctx.inject(Entities), root.inject(Entities)
const ENTITIES_PLUGIN_NAME = 'olas-entities' // the origin on its backprop writes

type EntityStore = {
  signal<T>(entity: EntityDef<T>, id: string): ReadSignal<T | undefined>
  get<T>(entity: EntityDef<T>, id: string): T | undefined
  upsert<T>(entity: EntityDef<T>, value: T): void
  update<T extends object>(
    entity: EntityDef<T>,
    id: string,
    patch: Partial<T> | ((prev: T) => T),
    options?: { merge?: 'shallow' | 'deep' },
  ): void
  remove<T>(entity: EntityDef<T>, id: string): void
  list<T>(entity: EntityDef<T>, options?: { filter?: (value: T) => boolean }): ReadSignal<T[]>
  // Devtools / debugging — non-reactive snapshots.
  entries<T>(entity: EntityDef<T>): ReadonlyMap<string, T>
  bindings<T>(entity: EntityDef<T>, id: string): ReadonlyArray<EntityBinding>
}
```

| Method | What |
|---|---|
| `defineEntity` | Module-scope entity descriptor. `idOf` should include a discriminating field check so unrelated objects with an `id` field aren't classified. `isCanonical` keeps a stub such as `{ id: '1' }` from overwriting the full record in the store. `maxSlots` caps the ids kept, see [Memory characteristics](#memory-characteristics). |
| `entitiesPlugin({ entities })` | Register entities on a root via `RootOptions.plugins`. The value is a definition: every root it is installed in gets its own store. Duplicate `name`s throw at construction. A root without `queries: queryEngine()` throws at `createRoot`. |
| `Entities` | The scope the store is provided under. `ctx.inject(Entities)` in a controller, `root.inject(Entities)` outside one. In a test, seed a fake through `RootOptions.scopes`. |
| `entities.signal(Post, id)` | Per-id `ReadSignal`. Stable across calls (interned). Read it via `@kontsedal/olas-react`'s `useValue(...)`. Throws if `Post` wasn't passed to `entitiesPlugin({ entities })`. |
| `entities.get(Post, id)` | Non-reactive read. It allocates no slot. Same registration check. |
| `entities.upsert(Post, raw)` | Explicit branding for non-query sources (WebSocket events, preloads). |
| `entities.update(Post, id, patchOrUpdater, options?)` | Merge a `Partial<T>`, or apply `(prev: T) => T`. `{ merge: 'deep' }` merges plain objects key by key; arrays and other values replace. Backpropagates to every query, batched. Warns in dev when the entity isn't in the store (no-op in prod). |
| `entities.remove(Post, id)` | Remove from store. Does NOT touch queries. Pair it with a query `write` to drop the entity from a list too. A handle from `signal(Post, id)` reads `undefined`, and follows the entity again once a query or `upsert` brings it back. |
| `entities.list(Post, { filter })` | Live `ReadSignal<Post[]>` of every `Post` the store holds. It updates when any of them changes. |
| `entities.entries(Post)` | Returns a fresh `Map<id, Post>` snapshot of the store. Mutating it does NOT affect the live store. |
| `entities.bindings(Post, id)` | Returns the reverse-index entries `[{ queryId, keyArgs, paths }]` for that id. Frozen copies. Empty array when the entity isn't held by any query. In shared data, see [Memory characteristics](#memory-characteristics) for which paths it lists. |

## How it works

The plugin's `onWrite` hook sees every cache write. For each one:

1. Drops the previous reverse-index bindings for that query and key.
2. Recursively walks the entry's data as it is now. For each subtree node, runs every registered entity's `idOf`. A non-null id means it's an entity.
3. Upserts the entity into the per-id signal AND records the path under the binding.

On `entities.update(Post, id, patch)`:

1. Compute `next = { ...current, ...patch }`.
2. Write `next` into the entity slot.
3. For each query entry the reverse index lists, find every node `idOf` claims as `id` in the entry's current data, and replace it with `next`. The plugin writes the rebuilt data with `host.queries.write`. All writes happen inside one `batch(...)`, so subscribers see one notification per affected query, not one per path.
4. Re-walk each patched entry, so a nested entity the patch brought in (a new author, say) is normalized too.

Step 3 reads the data at the time of the call, not the paths the last walk recorded. Another plugin can change an entry before this plugin walks it. One earlier in the plugin list reacts to a write first, and one that reacts to a backprop write can rewrite another entry mid-update. The patch then lands where the entity is now, and never on whatever took its old place. An entry that no longer holds the entity gets no write, and its binding is dropped. The rebuild keeps every unchanged subtree by reference.

The backprop writes carry `origin: 'olas-entities'`, and the plugin's `onWrite` skips its own origin, so an update does not re-trigger itself. When the cache garbage-collects an entry, the plugin drops that entry's bindings but keeps the entity values in the store. A detail view subscribed through `signal(Post, id)` keeps working, and a later fetch re-establishes the bindings.

## Devtools

In a development build, each `update` reports its backprop fan-out on the plugin's lane in `@kontsedal/olas-devtools`, through `host.debug`:

```ts nocheck
{ kind: 'update', entity: 'Post', id: 'p1', entries: 2, stale: 0, queries: ['feed', 'profile'] }
```

`entries` counts the query entries the patch was written into, and `queries` names their queries. `stale` counts the entries the reverse index listed that no longer held the entity. The default build strips the call.

The deep merge copies own keys only, and writes a `__proto__` key as a plain property. A patch parsed from JSON therefore cannot change a prototype (SPEC §22).

## Constraints

- **Regular and infinite queries are both walked.** An infinite query's pages are a `TPage[]`, and the walker's array branch records the page index as the first path segment. A backprop write routes into the pages the same way.
- **One plugin value, one store per root.** Define the plugin once at module scope and install it in every root that needs it. Roots do not share a store.
- **Entity must be registered.** `signal`, `get`, `upsert`, `update`, `remove`, `list`, `entries` and `bindings` throw when called with an `EntityDef` that wasn't passed to `entitiesPlugin({ entities })`. Catches the mistake at the call site instead of leaking orphan signals.
- **`update` default is shallow-merge.** Use `{ merge: 'deep' }`, or the function form (`update(Post, id, (prev) => ...)`), for nested and computed updates.
- **`update` is a no-op if the entity isn't in the store.** Warns in dev. Use `upsert` first if you want create-or-patch semantics.

## Memory characteristics

- **Per-id signal slots are allocated on first read** of `entities.signal(Post, id)`, or on first observation in a query. They live until the root disposes, unless the entity sets `maxSlots`. Calling `signal(Post, dynamicId)` with churning ids, such as per-render computed values, grows the slot map without bound. Dev builds emit a one-shot warning once any entity partition crosses 10k unique ids.
- **`maxSlots` evicts orphans.** When a partition grows past the cap, the plugin evicts ids that no query references and no `subscribe` on their handle holds, least recently used first. An id a query or a mounted view still holds is kept, even past the cap.
- **Handles outlive their slots.** The handle `signal(Post, id)` returns reads whatever slot the store holds for that id now. After `remove` or an eviction it reads `undefined`, and it follows the entity again once a query or `upsert` brings it back. `signal(Post, id)` returns the same handle for as long as anything holds it; the store keeps handles weakly, so a handle nothing holds is garbage-collected. An open `subscribe` holds its handle until it unsubscribes, even when the caller keeps only the unsubscribe function. A `computed` or an `effect` that reads a handle's `value` does not hold its slot against eviction: only `subscribe`, which the framework adapters use, does.
- **Walk cost is linear in the data** on every cache write: one `idOf` call per entity type for each object and each reference to it. The walker uses one mutable path accumulator (push on descent, pop on ascent) and clones only at binding boundaries.
- **Shared-reference DAGs** are handled correctly. The walker descends into each object once. A single `Post` object reachable via two keys gets a binding at both. An entity nested inside a shared object is bound at the path the walker first reached it by, so `bindings()` lists one path per reference into it, not every path. A chain of diamonds with 2^depth paths therefore costs depth, not 2^depth. `update` does not depend on the paths: it finds the entity in the data, rebuilds a shared object once, and keeps it shared. True cycles (a `Post` referencing itself) short-circuit on the second descent.

## Interaction with `@kontsedal/olas-cross-tab`

A write another tab sent reaches this plugin like any other write, so the receiving tab's store follows the mirrored query data.

The plugin's own backprop writes carry `origin: 'olas-entities'`, and `crossTabPlugin` mirrors only the app's own writes by default. So an `entities.update(...)` patch stays in its tab. That default fits an update every tab makes for itself, such as a realtime push each tab receives. Mirroring it would send one message per tab and write every peer twice. When one tab's UI makes the update, list the plugin in cross-tab's `origins`, and the peer walks the mirrored write into its own store:

```ts
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { ENTITIES_PLUGIN_NAME } from '@kontsedal/olas-entities'

const crossTab = crossTabPlugin({ channelName: 'my-app/cache/v1', origins: [ENTITIES_PLUGIN_NAME] })
```

## What's NOT included

- `entity.subscribe(id)` outside React — use `entities.signal(Post, id).subscribe(handler)` directly.

## Further reading

- [`../../.wiki/modules/entities.md`](../../.wiki/modules/entities.md)
- [SPEC §18.1](../../SPEC.md#181-entity-normalization) — the worked example this package replaces.
- SPEC §13 — the plugin host and the cache-write events it observes.
- [SPEC §20.8](../../SPEC.md#208-root--options) — `RootOptions.plugins`.
