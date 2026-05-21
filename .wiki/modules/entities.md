---
name: entities
description: "@kontsedal/olas-entities — entity-normalization plugin built on QueryClientPlugin (auto-walk + reverse index + backprop)."
type: module
covers:
  - packages/entities/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: documented-in, target: ../../BACKLOG.md }
  - { type: tested-by, target: ../../packages/entities/tests/entities.test.ts }
  - { type: uses, target: query.md }
  - { type: uses, target: signals.md }
  - { type: related, target: cross-tab.md }
last_verified: 2026-05-21
confidence: medium
---

# `@kontsedal/olas-entities`

Layered on the `QueryClientPlugin` surface (SPEC §13.2). Solves the cross-query update problem (SPEC §18.1): when the same `Post`/`User` lives in `newsfeedQuery`, `profileQuery`, `searchQuery`, etc., `entities.update(Post, id, patch)` patches every query holding that id, in one call.

## Surface

| Name | Signature | Notes |
|---|---|---|
| `defineEntity<T>` | `({ name, idOf: (v) => string \| null }) => EntityDef<T>` | Module-scope; the handle is the `entity` argument to every plugin method. |
| `entitiesPlugin` | `(entities: EntityDef<unknown>[]) => EntitiesPlugin` | Installed via `RootOptions.plugins[]`. One instance per root (reuse throws via `onError`, mirroring cross-tab). Duplicate `name`s throw at construction. |
| `plugin.signal<T>(entity, id)` | `(entity, id) => ReadSignal<T \| undefined>` | Lazily-allocated per-id signal. Stable across calls. Throws when `entity` wasn't registered (catches the mistake at the call site instead of leaking orphan signals). |
| `plugin.get<T>(entity, id)` | `(entity, id) => T \| undefined` | Non-reactive peek. Same registration check. |
| `plugin.upsert<T>(entity, value)` | `(entity, value) => void` | Explicit branding for non-query sources (WebSocket events, preloads). |
| `plugin.update<T extends object>(entity, id, patchOrUpdater, options?)` | `(entity, id, Partial<T> \| ((prev: T) => T), { merge?: 'shallow' \| 'deep' }?) => void` | Backpropagate to every query holding the id. Batched. `Partial<T>` patch merges per `options.merge` (default `'shallow'`); `(prev) => next` updaters compute the result directly. `'deep'` recurses into plain objects (arrays / non-plain values replace). Warns in dev when the entity isn't in the store (no-op in prod). |
| `plugin.invalidate<T>(entity, id)` | `(entity, id) => void` | Remove from store. Does NOT mutate queries. |
| `plugin.entries<T>(entity)` | `(entity) => ReadonlyMap<string, T>` | Devtools snapshot. Fresh `Map<id, T>` per call — mutating it does not affect the store. |
| `plugin.bindings<T>(entity, id)` | `(entity, id) => readonly EntityBinding[]` | Devtools view of the reverse index for one id. Deep-cloned; safe to mutate. Empty array when the entity isn't held by any query. |

## How auto-walk works

On every `SetDataEvent` with `kind: 'data'` (sources `'fetch' | 'set' | 'remote'`), the plugin:

1. Drops the previous reverse-index bindings for the `(queryId, keyArgs)` pair (rebuild rather than diff — simpler, bounded by query size).
2. Recursively walks `event.data`. For every reachable subtree node, runs every registered entity's `idOf(node)`. A non-null id means the node IS an entity instance.
3. Upserts the entity into the per-id signal AND registers a binding `(queryId, keyArgs, path)` in the reverse index.

### Path accumulator

The walker reuses **one mutable `Array<string | number>`** across the whole traversal — pushed on descent, popped on ascent. Allocations happen only at binding boundaries (`.slice()` inside `addBinding`). This drops the per-recursion allocation cost from `O(N × D)` to `O(bindings recorded)`.

### Cycle vs DAG handling

The cycle guard is a `WeakSet` of objects **currently being descended into** — added on entry, removed on exit. This is true depth-first cycle detection, not "ever visited":

- **True cycle** (`post.self = post`): the second descent finds the node already in `inProgress` and short-circuits.
- **Shared-reference DAG** (same `Post` object reached via `posts[3]` AND `pinned`): the second visit happens AFTER the first has popped, so it walks again and records both bindings. The earlier `WeakSet`-of-ever-visited would have lost the second path and silently broken `entity.update`'s backprop for that path.

See `packages/entities/src/index.ts:283-329`.

## How backprop avoids infinite loops

`entities.update(Post, id, patch)` does (`src/index.ts:347-373`):

1. Read current entity from the slot.
2. Compute `next = { ...current, ...patch }` (one new object reference).
3. `slot.set(next)` — store update.
4. For each binding in the reverse index, call `api.setEntryData(queryId, keyArgs, prev => setAtPath(prev, path, next))`.

`setEntryData` fires a `SetDataEvent` with `source: 'set'`. The plugin's own `onSetData` runs and re-walks. It finds `next` at the same path, calls `slot.set(next)` again — but `@preact/signals-core` dedups via `Object.is`, so it's a no-op. **The loop terminates after one cycle.**

This relies on `setAtPath` returning a structure that shares siblings by reference (immutable spread), so sibling entities also stay `===` to their slot values and dedup the same way. See `src/index.ts:303-326`.

## Where the new core hooks live

- **`SetDataEvent.source: 'set' | 'fetch' | 'remote'`** — added in `packages/core/src/query/plugin.ts:60-83`. Lets the plugin react to fetch results (not just explicit `setData`).
- **`Entry.onSuccessData` callback** — `packages/core/src/query/entry.ts:21-32, 178-187`. Fires from `applySuccess` after the batched signal writes. `ClientEntry` wires it in `client.ts:69-77` to call `client.emitSetData(query, keyArgs, data, 'data', 'fetch')`.
- **`QueryClientPluginApi.setEntryData(queryId, keyArgs, updater)`** — `plugin.ts:34-58`, implemented at `client.ts:577-595`. Local-originated setData by keyArgs. Cross-tab WILL rebroadcast (`source: 'set'`).
- **Cross-tab now skips `source: 'fetch'`** — `packages/cross-tab/src/plugin.ts:163-168`. Each tab runs its own fetcher; broadcasting fetch results would be quadratic noise.

## Constraints (v1)

- **Regular and infinite queries both walked.** Infinite payloads (`kind: 'infinite'`) traverse the `TPage[]` shape transparently — the walker's existing array branch handles page indices, and `setEntryData` routes infinite-keyed writes back through `InfiniteEntry.setData` (`packages/core/src/query/client.ts`). Cross-tab still skips infinite (different concern: payload size).
- **One plugin instance per root.** Sharing a plugin instance across `createRoot(...)` calls would clobber the store and corrupt the reverse index. Construct a fresh `entitiesPlugin([...])` per root.
- **Entity must be registered.** All public methods throw when called with an `EntityDef` not in the plugin's entities array. Catches the mistake at the call site instead of leaking orphan signals.
- **`update` default is shallow-merge** (`Partial<T>`). The function form `update(id, prev => next)` covers non-shallow updates without forcing a third package.
- **No `entity.update` without a stored value.** No value to patch onto. `__DEV__` builds emit a `console.warn` to make this loud; production builds silently bail.

## bindingKey uses `stableHash`

Reverse-index keys are `${queryId} ${stableHash(keyArgs)}`. `stableHash` is the same canonicalizer the core `QueryClient` uses for its own per-entry hash — Date values canonicalize to ISO strings, object keys sort, `undefined` distinguishes from absent, and functions / symbols / Map / Set throw. This means an entities binding key collides with the `QueryClient` entry it points at iff the same `keyArgs` would, so `api.setEntryData(queryId, keyArgs, ...)` always finds the right entry.

## Memory model

- Per-id signals are interned in a `Map<entityName, Map<id, Signal>>`. They survive until plugin `dispose` (the slot Map is cleared all at once).
- Reverse-index entries are tied to query entries. On `onGc(event)`, the bindings for the gc'd entry are dropped from the reverse index. The entity slot stays (a detail view subscribed to that entity should keep working even when its source query is gc'd).
- Orphaned entity slots accumulate over the app's lifetime. Set `defineEntity({ maxSlots })` to cap the slot map: on overflow, the plugin evicts orphans (entities with no live bindings) in LRU order on the next slot insert. Bound entities are never evicted; if the cap is smaller than the bound-entity count, the cap is silently exceeded. A one-shot dev warning still fires at `SLOT_BLOAT_WARN_AT` (10k) for partitions without a cap.

## Tests

`packages/entities/tests/entities.test.ts` covers (25 tests):

- defineEntity branding + idOf semantics
- duplicate-name rejection
- auto-walk from fetch into the store
- per-id signal observation
- explicit `upsert` + idOf null no-op
- `update` patching a single query
- `update` reaching the same id at multiple paths in one query
- `update` reaching the same id across multiple queries
- update is a no-op when entity isn't in the store (dev warning fires)
- subscriber notifications coalesce (one call per affected query/signal per update)
- plugin reuse across roots → `onError` with `kind: 'plugin'`
- reverse index drops bindings when an entity disappears from a query (via `setData`)
- signal handle stability per id
- `invalidate` is store-only (doesn't touch queries)
- cycle in query data doesn't stack-overflow
- non-entity objects with an `id` field aren't classified (idOf discriminator works)
- **shared-reference DAG** — one `Post` object at two paths records both bindings
- **true cycle (`post.self = post`)** — short-circuits, records one binding at the root path
- **unregistered entity** — every public method throws
- **Date in keyArgs** — bindingKey via `stableHash` matches the QueryClient's entry hash
- **updater function** — `update(id, prev => next)` works alongside `Partial<T>`
- **`entries()`** — returns a fresh Map snapshot; mutating it doesn't affect the live store
- **`bindings()`** — deep-cloned; safe to mutate; unknown ids return `[]`

## Where to read next

- `packages/entities/src/index.ts` — ~440 lines, whole package.
- `SPEC.md` §18.1 — the worked example this package replaces.
- `modules/query.md` — the underlying `setData` / fetch lifecycle.
- `modules/cross-tab.md` — closest sibling plugin (lifecycle + plugin reuse pattern).
- `BACKLOG.md` → `@kontsedal/olas-entities` entry (now `[done]`).
