---
name: query
description: Local cache, shared queries (defineQuery + ctx.use), mutations, infinite queries, SSR.
type: module
covers:
  - packages/core/src/query/actions.ts
  - packages/core/src/expiry-timer.ts
  - packages/core/src/query/types.ts
  - packages/core/src/query/entry.ts
  - packages/core/src/query/local.ts
  - packages/core/src/query/keys.ts
  - packages/core/src/query/client.ts
  - packages/core/src/query/define.ts
  - packages/core/src/query/use.ts
  - packages/core/src/query/mutation.ts
  - packages/core/src/query/infinite.ts
  - packages/core/src/plugin/host.ts
  - packages/core/src/query/index.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/query-isolation.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/cache-identity.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/expiry-timers.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-default-options.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-focus-online.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: uses, target: ../entities/mutation.md }
  - { type: uses, target: ../decisions/canonical-vs-optimistic-writes.md }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
last_verified: 2026-09-20
confidence: high
---

# `packages/core/src/query/`

The largest module — owns async data, mutations, and SSR. Spec §5, §6, §7, §15.

## Files

| File | Owns |
|------|------|
| `types.ts` | `AsyncState`, `AsyncStatus`, `LocalCache`, `Snapshot`, `Query`, `QuerySpec`, `QueryDefaults`, `QuerySubscription`, `QuerySubscriptionOptions`, `DehydratedState`, `RetryPolicy`, `RetryDelay`, `RefetchInterval`, `NetworkMode`, `FetchCtx` |
| `entry.ts` | `Entry<T>` — race-protected state machine for one cache key. Retry loop. Snapshot stack. Staleness timer. |
| `local.ts` | `LocalCache<T>` wrapper + `createLocalCache(fetcher, options)`. Backs `createCache`. |
| `keys.ts` | `stableHash(args)` — deterministic JSON-based hashing. Sorted object keys. Handles `Date` and `undefined`. Throws on functions / symbols. |
| `client.ts` | `QueryClient`, `ClientEntry<T>`, `InfiniteClientEntry`. Per-root entry registry, gcTime, the refetch-interval chain (`resolveRefetchInterval` + `armIntervalTick`, `client.ts:30-82`), `mutationsInflight$`, dehydrate/hydrate/waitForIdle. |
| `define.ts` | `defineQuery`, `defineInfiniteQuery`. Module-scoped values branded under core's `BRAND` symbol. Carry a `__clients: Set<QueryClient>` for multi-root operation. |
| `use.ts` | `createUse` and `createInfiniteUse`. Build a `SubscriptionImpl` that swaps entries reactively on key change. |
| `mutation.ts` | `MutationImpl` — three concurrency modes, abort-race, snapshot rollback. |
| `infinite.ts` | `InfiniteEntry<TPage, TItem, PageParam>` — paginated variant. Owns `pages`, `pageParams`, `fetchNextPage`, `fetchPreviousPage`. A refetch (interval/invalidate/refetch) re-fetches ALL loaded pages via `runRefetchAll`, not just page one (T3.7). Not dehydrated for SSR (BACKLOG). |
| `plugin.ts` | `QueryClientPlugin` contract + the `queryId → Query` registry. Used by `@kontsedal/olas-cross-tab`. Spec §13.2. |
| `index.ts` | re-exports |

## How a subscription is wired

```
createQuery(ctx, query, () => [id])
   ↓
createUse / createInfiniteUse           (dispatch on the query's brand)
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

## Root-scoped invalidation

A `Query` is module-scoped. Binding a handle or entry registers its client in `query.__clients`. Bound actions select that client; unbound calls fail when multiple clients are registered. Disposal unregisters the client. See `../decisions/per-root-query-client.md` and `query-isolation.test.ts`.

`invalidate` and `invalidateAll` return a `Promise<void>` for the selected root. Fetch errors route to that root's `onError`; ambiguity and root disposal reject. A subscriber-less entry is marked stale without refetching. See spec §5.7 and §21.5.

## The imperative surface: read, and two kinds of write

Beyond `createQuery`, the handle carries the operations that reach a keyed entry from outside a subscription — `invalidate`, `invalidateAll`, `cancel`, `cancelAll`, `prefetch` and `setData`, and since 0.6.0 also:

- **`peek(...keyArgs): T | undefined`** (`client.peekData`, `client.ts`) — synchronous read. Looks the entry up in `maps` **without** `bindEntry`, so a peek cannot mint the entry it is asking about, and reads through `.peek()` so it registers no reactive dependency. `undefined` conflates "no entry" with "not settled", deliberately: the caller that cares is guarding a write, and both answers mean *don't*. The bound handle reads only its selected root. An unbound peek returns undefined for zero clients and throws on multiple clients.
- **`write(...keyArgs, updater): void`** (`client.writeData`) — canonical write: `Entry.setData(updater, { track: false })`, so no snapshot record and no `hasPendingMutations` flip. Same entry-binding and the same `source: 'set'` event as `setData`; the devtools `source` is pinned to `'set'` rather than inheriting `'mutate'` from an ambient cause. Why this is a separate method rather than an option: `decisions/canonical-vs-optimistic-writes.md`.

`setData` remains the **optimistic** write, and its snapshot is the caller's to settle — see `pitfalls/no-invalidator-still-refetches.md` for the `cancel()`-first rule that applies to it even when nothing invalidates the query.

## How mutations integrate with the cache

- `onMutate` typically calls `query.setData(...)`. That writes through `client.setData` which calls `entry.setData(updater)`. The Entry records a snapshot (pre-value) and returns `{ rollback }`.
- `onError(err, vars, snapshot)` typically calls `snapshot?.rollback()`. Rolling back the top-of-stack snapshot restores its captured pre-value; a non-top rollback under concurrency chain-splices instead so out-of-order rollbacks still converge on the original value (spec §6.4, `entities/entry.md`).
- For `concurrency: 'latest-wins'`, the previous run's snapshot rolls back **synchronously before the new run's `onMutate` is called** — see `pitfalls/latest-wins-rollback-order.md`.
- Mutation inflight is tracked centrally on `queryClient.mutationsInflight$`. `root.waitForIdle()` waits on it plus per-entry `isFetching`.

## Network mode & `isPaused`

`QuerySpec.networkMode` (`'online'` default, `'always'` and `'offlineFirst'`) gates fetches on `navigator.onLine`. `online` defers a fetch requested while offline, in `Entry.scheduleDeferredFetch`, and resumes on the `online` event through `subscribeReconnect` and `drainDeferred` in `focus-online.ts`. `offlineFirst` runs the fetch, but on a `fetch` `TypeError` raised while offline it parks and retries on reconnect instead of surfacing the error; see the `runWithRetry` catch in `entry.ts` (T3.5). Both parked paths set the `isPaused` signal, new on `AsyncState`. It is `true` while waiting for the network and `false` whenever a fetch is in flight or settled. `always` never parks. Spec §5.5; pinned by `query-focus-online.test.ts` (R-Q3.5). Infinite entries park the same way in both fetch loops, `runRefetchAll` and `runFetch` (1.0). The drain re-runs the parked direction, and a parked refetch re-runs the whole refetch.

## SSR

`root.dehydrate()` walks `client.maps` and `client.infiniteMaps`, and emits `{ id: queryId, key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'`, plus `pageParams` for an infinite entry. Error and idle entries are skipped. `createRoot(def, { hydrate: state })` populates a per-client `hydratedData` map at `client.ts:972-996`. The first `bindEntry` matching both the explicit ID and the key hash consumes the row and threads `initialData` into the new `Entry` at `client.ts:1121-1123`. The `bindEntry` site ALSO emits a `SetDataEvent` with `source: 'fetch'` when the new entry consumes hydrated data, at `client.ts:1155-1157`. Without that, plugins observing fetch results, such as entities, would miss every hydrated row, because `Entry.applySuccess` never runs for entries that start with `initialData`. See `flows/ssr.md`. For phase-2 streaming SSR the same flow is driven row by row through `QueryClient.applyDehydratedEntry` at `client.ts:863-892`. That buffers into `hydratedData` when the entry is not bound yet, and applies directly through `applyRemoteSetData` when it is.

## Plugin slot

The `QueryClient` accepts `plugins?: QueryClientPlugin[]` (forwarded from `RootOptions.plugins`). Plugins observe `setData`, `invalidate` or `gc` and can push remote-originated writes back through the cache via `QueryClientPluginApi.applyRemoteSetData`, `applyRemoteInvalidate` or `setEntryData`. Spec §13.2. Surface:

- **`init(api)`** — called once after construction. Wire transports here. The `api` is closed over the client; safe to retain.
- **`onSetData(event)`** — fires on every cache write. `event.source` discriminates origin. `'set'` covers an explicit `client.setData`, a mutation, and a plugin-initiated `setEntryData`. `'fetch'` covers a fetcher that resolved through `Entry.applySuccess`, and a hydrated entry first bound through `bindEntry`. `'remote'` covers `applyRemoteSetData`. `event.isRemote` is `true` only for `'remote'`, so `source === 'remote'` and `isRemote === true` are equivalent. Both are kept for back-compat, because cross-tab gates on `isRemote` and entities gates on `source`. Infinite queries fire with `kind: 'infinite'` for BOTH an explicit `setData`, which is `'set'`, AND a successful page fetch, which is `'fetch'` for initial, next and previous, via the `onSuccessData` closure handed to `InfiniteEntry`. `cross-tab` skips `kind: 'infinite'`. `entities` walks it: `event.data` is `TPage[]`, so the path accumulator records `[pageIdx, ...inPagePath]` and `setEntryData` routes infinite-keyed writes back through `InfiniteEntry.setData`.
- **`onInvalidate(event)`** — every invalidate (regular + infinite). Same `isRemote` semantics.
- **`onGc(event)`** — every entry drop. No `isRemote` (gc is local).
- **`dispose()`** — called from `QueryClient.dispose`. Tear down transports.

`QueryClientPluginApi.setEntryData(queryId, keyArgs, updater)` writes back into a specific entry by `keyArgs` (not `callArgs`). Used by `@kontsedal/olas-entities` to backpropagate entity patches into every query holding the entity without recovering the original args. The resulting `SetDataEvent` has `source: 'set'`, `isRemote: false` — cross-tab WILL rebroadcast.

Plugin callbacks are wrapped in try/catch; exceptions route to the root's `onError` with `kind: 'plugin'`. The `queryId → Query` registry, built from `registerQueryById` and `lookupRegisteredQuery` in `plugin.ts`, routes inbound messages back to the right query value across module-graph boundaries, whether cross-tab or cross-process.

Plugin events fire only for queries that have a `queryId`. Queries without one are silently invisible to plugins — a `crossTab: true` spec without a `queryId` triggers a one-time `console.warn` from `defineQuery` (dev only).

Canonical consumers: `modules/cross-tab.md`, which broadcasts `setData` across tabs, and `modules/entities.md`, a normalized per-id signal store with cross-query backprop.

## Notable gotchas (full details in `../pitfalls/`)

- `callArgs` is forwarded to the fetcher; `keyArgs` is hashed. See `../pitfalls/callargs-vs-keyargs.md`.
- `isStale` is a `Signal` with a `setTimeout`, not a computed. See `../pitfalls/isstale-needs-timer.md`.
- Mutation `latest-wins` rollback ordering. See `../pitfalls/latest-wins-rollback-order.md`.
- Mutation's `raceAbort` defends against misbehaving mutate fns. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.

## 0.9 identity and lifetime guarantees

Bound query operations target one root; unbound calls fail if multiple roots have touched the definition. SSR serializes only explicit query IDs. Cache keys recursively tag all values, preventing user strings/objects from imitating special values. Stale timers skip Infinity and split long finite delays into platform-safe chunks. See the three regression files linked above and SPEC §21.5.
