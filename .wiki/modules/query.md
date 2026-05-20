---
name: query
description: Local cache, shared queries (defineQuery + ctx.use), mutations, infinite queries, SSR.
type: module
covers:
  - packages/core/src/query/types.ts
  - packages/core/src/query/entry.ts
  - packages/core/src/query/local.ts
  - packages/core/src/query/keys.ts
  - packages/core/src/query/client.ts
  - packages/core/src/query/define.ts
  - packages/core/src/query/use.ts
  - packages/core/src/query/mutation.ts
  - packages/core/src/query/infinite.ts
  - packages/core/src/query/plugin.ts
  - packages/core/src/query/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: uses, target: ../entities/mutation.md }
last_verified: 2026-05-20
confidence: medium
---

# `packages/core/src/query/`

The largest module — owns async data, mutations, and SSR. Spec §5, §6, §7, §15.

## Files

| File | Owns |
|------|------|
| `types.ts` | `AsyncState`, `AsyncStatus`, `LocalCache`, `Snapshot`, `Query`, `QuerySpec`, `QuerySubscription`, `UseOptions`, `DehydratedState`, `RetryPolicy`, `RetryDelay` |
| `entry.ts` | `Entry<T>` — race-protected state machine for one cache key. Retry loop. Snapshot stack. Staleness timer. |
| `local.ts` | `LocalCache<T>` wrapper + `createLocalCache(fetcher, options)`. Backs `ctx.cache`. |
| `keys.ts` | `stableHash(args)` — deterministic JSON-based hashing. Sorted object keys. Handles `Date` and `undefined`. Throws on functions / symbols. |
| `client.ts` | `QueryClient`, `ClientEntry<T>`, `InfiniteClientEntry`. Per-root entry registry, gcTime, refetchInterval, `mutationsInflight$`, dehydrate/hydrate/waitForIdle. |
| `define.ts` | `defineQuery`, `defineInfiniteQuery`. Module-scoped values branded `__olas`. Carry a `__clients: Set<QueryClient>` for multi-root operation. |
| `use.ts` | `createUse` and `createInfiniteUse`. Build a `SubscriptionImpl` that swaps entries reactively on key change. |
| `mutation.ts` | `MutationImpl` — three concurrency modes, abort-race, snapshot rollback. |
| `infinite.ts` | `InfiniteEntry<TPage, TItem, PageParam>` — paginated variant. Owns `pages`, `pageParams`, `fetchNextPage`, `fetchPreviousPage`. |
| `plugin.ts` | `QueryClientPlugin` contract + the `queryId → Query` registry. Used by `@kontsedal/olas-cross-tab`. Spec §13.2. |
| `index.ts` | re-exports |

## How a subscription is wired

```
ctx.use(query, () => [id])
   ↓
createUse / createInfiniteUse           (dispatch on query.__olas brand)
   ↓
effect tracks keyFn + enabledFn
   ↓
QueryClient.bindEntry(query, args)      (or bindInfiniteEntry)
   ↓
ClientEntry wraps Entry<T>              (or InfiniteClientEntry wraps InfiniteEntry)
   ↓
SubscriptionImpl.attach(entry)
   ↓
sub.data / .error / .status / ...       (computeds over current$)
```

See `flows/query-subscription.md`.

## How invalidation propagates across roots

A `Query` is module-scoped. Each `QueryClient` that has bound an entry for it registers itself in `query.__clients`. `query.invalidate(...args)` iterates `__clients` and calls `client.invalidate(query, args)` on each. On root dispose, the client removes itself from every touched query's set — this is the mechanism for test isolation. See `decisions/per-root-query-client.md`.

## How mutations integrate with the cache

- `onMutate` typically calls `query.setData(...)`. That writes through `client.setData` which calls `entry.setData(updater)`. The Entry records a snapshot (pre-value) and returns `{ rollback }`.
- `onError(err, vars, snapshot)` typically calls `snapshot?.rollback()`. The Entry restores the captured pre-value.
- For `concurrency: 'latest-wins'`, the previous run's snapshot rolls back **synchronously before the new run's `onMutate` is called** — see `pitfalls/latest-wins-rollback-order.md`.
- Mutation inflight is tracked centrally on `queryClient.mutationsInflight$`. `root.waitForIdle()` waits on it plus per-entry `isFetching`.

## SSR

`root.dehydrate()` walks `client.maps` and emits `{ key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'`. Infinite queries and error/idle entries are intentionally skipped. `createRoot(def, { hydrate: state })` populates a per-client `hydratedData` map; the first `bindEntry` matching a hash consumes the row and threads `initialData` into the new `Entry`. The `bindEntry` site ALSO emits a `SetDataEvent` with `source: 'fetch'` when the new entry consumes hydrated data — without that, plugins observing fetch results (entities, etc.) would miss every hydrated row, since `Entry.applySuccess` never runs for entries that start with `initialData`. See `flows/ssr.md` and `client.ts:756-770`.

## Plugin slot

The `QueryClient` accepts `plugins?: QueryClientPlugin[]` (forwarded from `RootOptions.plugins`). Plugins observe `setData` / `invalidate` / `gc` and can push remote-originated writes back through the cache via `QueryClientPluginApi.applyRemoteSetData` / `applyRemoteInvalidate` / `setEntryData`. Spec §13.2. Surface:

- **`init(api)`** — called once after construction. Wire transports here. The `api` is closed over the client; safe to retain.
- **`onSetData(event)`** — fires on every cache write. `event.source` discriminates origin: `'set'` (explicit `client.setData` / mutation / plugin-initiated `setEntryData`), `'fetch'` (fetcher resolved successfully via `Entry.applySuccess`, OR a hydrated entry was first bound via `bindEntry`), or `'remote'` (`applyRemoteSetData`). `event.isRemote` is `true` only for `'remote'` — `source === 'remote' ⇔ isRemote === true`, kept dual for back-compat (cross-tab gates on `isRemote`, entities gates on `source`). Infinite queries also fire with `kind: 'infinite'` for explicit `setData` but DO NOT yet fire on fetch — `kind: 'infinite' + source: 'fetch'` is reserved (cross-tab and entities both skip infinite in v1).
- **`onInvalidate(event)`** — every invalidate (regular + infinite). Same `isRemote` semantics.
- **`onGc(event)`** — every entry drop. No `isRemote` (gc is local).
- **`dispose()`** — called from `QueryClient.dispose`. Tear down transports.

`QueryClientPluginApi.setEntryData(queryId, keyArgs, updater)` writes back into a specific entry by `keyArgs` (not `callArgs`). Used by `@kontsedal/olas-entities` to backpropagate entity patches into every query holding the entity without recovering the original args. The resulting `SetDataEvent` has `source: 'set'`, `isRemote: false` — cross-tab WILL rebroadcast.

Plugin callbacks are wrapped in try/catch; exceptions route to the root's `onError` with `kind: 'plugin'`. The `queryId → Query` registry (`registerQueryById` / `lookupRegisteredQuery` in `plugin.ts`) routes inbound messages back to the right query value across module-graph boundaries (cross-tab, cross-process).

Plugin events fire only for queries that have a `queryId`. Queries without one are silently invisible to plugins — a `crossTab: true` spec without a `queryId` triggers a one-time `console.warn` from `defineQuery` (dev only).

Canonical consumers: `modules/cross-tab.md` (broadcast `setData` across tabs), `modules/entities.md` (normalized per-id signal store + cross-query backprop).

## Notable gotchas (full details in `../pitfalls/`)

- `callArgs` (forwarded to fetcher) vs `keyArgs` (hashed). See `../pitfalls/callargs-vs-keyargs.md`.
- `isStale` is a `Signal` with a `setTimeout`, not a computed. See `../pitfalls/isstale-needs-timer.md`.
- Mutation `latest-wins` rollback ordering. See `../pitfalls/latest-wins-rollback-order.md`.
- Mutation's `raceAbort` defends against misbehaving mutate fns. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.
