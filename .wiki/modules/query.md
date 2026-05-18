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
last_verified: 2026-05-18
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

`root.dehydrate()` walks `client.maps` and emits `{ key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'`. Infinite queries and error/idle entries are intentionally skipped. `createRoot(def, { hydrate: state })` populates a per-client `hydratedData` map; the first `bindEntry` matching a hash consumes the row and threads `initialData` into the new `Entry`. See `flows/ssr.md`.

## Notable gotchas (full details in `../pitfalls/`)

- `callArgs` (forwarded to fetcher) vs `keyArgs` (hashed). See `../pitfalls/callargs-vs-keyargs.md`.
- `isStale` is a `Signal` with a `setTimeout`, not a computed. See `../pitfalls/isstale-needs-timer.md`.
- Mutation `latest-wins` rollback ordering. See `../pitfalls/latest-wins-rollback-order.md`.
- Mutation's `raceAbort` defends against misbehaving mutate fns. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.
