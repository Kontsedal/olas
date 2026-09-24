---
name: query
description: The query engine — local caches, shared queries (defineQuery + createQuery), mutations, infinite queries, SSR, and the query half of the plugin host.
type: module
covers:
  - packages/core/src/query/actions.ts
  - packages/core/src/query/bind.ts
  - packages/core/src/query/client.ts
  - packages/core/src/query/define.ts
  - packages/core/src/query/engine.ts
  - packages/core/src/query/entry.ts
  - packages/core/src/query/errors.ts
  - packages/core/src/query/focus-online.ts
  - packages/core/src/query/index.ts
  - packages/core/src/query/infinite.ts
  - packages/core/src/query/keys.ts
  - packages/core/src/query/local.ts
  - packages/core/src/query/missing-engine.ts
  - packages/core/src/query/mutation-registry.ts
  - packages/core/src/query/mutation.ts
  - packages/core/src/query/structural-share.ts
  - packages/core/src/query/types.ts
  - packages/core/src/query/use.ts
  - packages/core/src/expiry-timer.ts
  - packages/core/src/plugin/types.ts
  - packages/core/src/plugin/host.ts
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
  - { type: tested-by, target: ../../packages/core/tests/infinite-parity.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: uses, target: ../entities/mutation.md }
  - { type: uses, target: ../decisions/canonical-vs-optimistic-writes.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: related, target: ../flows/plugin-lifecycle.md }
  - { type: related, target: ../decisions/infinite-query-parity.md }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
last_verified: 2026-09-25
confidence: high
---

# `packages/core/src/query/`

The largest module. It owns async data, mutations and SSR. Spec §5, §6, §7, §15.

A root has a query engine only when `createRoot` gets `queries: queryEngine()`. `queryEngine` (`engine.ts:69-86`) is a definition: each adopting root gets its own `QueryClient`, built eagerly inside `createRoot` before plugin setup. `engine.ts` is the only module that imports `QueryClient` as a value, so a root without an engine leaves the client out of the bundle. The primitives that need one throw `missingQueryEngine(...)` (`missing-engine.ts:15-20`), a message that names the fix.

## Files

| File | Owns |
|------|------|
| `types.ts` | `AsyncState`, `AsyncStatus`, `LocalCache`, `Snapshot`, `Query`, `QueryActions`, `QuerySpec`, `QueryMeta`, `QueryDefaults`, `QuerySubscription`, `QuerySubscriptionOptions`, `QuerySelectOptions`, `DehydratedEntry`, `DehydratedState`, `RetryPolicy`, `RetryDelay`, `RefetchInterval`, `NetworkMode`, `FetchCtx` |
| `bind.ts` | The ctx-taking entry points: `createQuery`, `createCache`, `createMutation`, `bindQuery` (`bind.ts:36-176`). Each reaches the controller through `ctxInternals`. |
| `engine.ts` | `queryEngine({ defaults })`, `QueryEngine`, `QueryEngineOptions`, and the internal `QueryEngineHost` that `createRoot` hands it. |
| `missing-engine.ts` | The "no query engine" error, kept apart so nothing reachable from `createRoot` imports `engine.ts`. |
| `entry.ts` | `Entry<T>`, the race-protected state machine for one cache key. Retry loop, snapshot stack, staleness timer. `EntryEvents`, the devtools callback bundle. |
| `local.ts` | `LocalCacheImpl` and `createLocalCache(fetcher, options, deps)`. Backs `createCache`. |
| `keys.ts` | `stableHash(args)`: a type-tagged JSON encoding, so user data cannot impersonate an internal tag. Object keys are sorted, `-0` is `0`, and a `Date` encodes as its ISO string. It throws on functions, symbols, `Map`, `Set`, class instances and cycles (`keys.ts:7-60`). Plugins reach it as `host.queries.hashKey`. |
| `structural-share.ts` | `structuralShare(prev, next)`, which keeps `prev`'s references wherever a refetch returned equal content. `Entry.applySuccess` runs it unless `structuralShare: false`. |
| `client.ts` | `QueryClient`, `ClientEntry<T>`, `InfiniteClientEntry`. The per-root entry registry, `gcTime`, the refetch-interval chain (`resolveRefetchInterval` at `client.ts:62-93`, `armIntervalTick` at `client.ts:354-390`), `mutationsInflight$`, dehydrate, hydrate and `waitForIdle`. The query half of the plugin host (below). |
| `define.ts` | `defineQuery`, `defineInfiniteQuery`. Both assert a non-empty `id` (`define.ts:12-19`) and brand the value under core's `BRAND` symbol. Each carries a `__clients: Set<QueryClient>` for multi-root operation, and the unbound actions from `actions.ts`. |
| `actions.ts` | `createQueryActions` and `createInfiniteQueryActions`: the `invalidate`, `setData`, `write`, `replace`, `peek`, `cancel` and `prefetch` surface, over a client resolver and an optional `origin` (`actions.ts:24-120`). `singleClient` throws on an ambiguous unbound call. |
| `use.ts` | `createUse` and `createInfiniteUse`. Build a `SubscriptionImpl` that swaps entries reactively on a key change. `AttachWaiters` and `FirstValueCache` back `firstValue()` on a detached subscription. |
| `errors.ts` | `QueryDisabledError`, which `refetch()` rejects with on a disabled subscription. See `../decisions/disabled-subscriptions.md`. |
| `mutation.ts` | `MutationImpl` with three concurrency modes, the abort race and snapshot rollback. `defineMutation`, `MutationDisposedError`, `MutationLifecycleHooks`. |
| `mutation-registry.ts` | The module-level `defineMutation` registry by `id`. `host.mutations.run` looks definitions up here. Internal. |
| `infinite.ts` | `InfiniteEntry<TPage, TItem, PageParam>`, the paginated variant. Owns `pages`, `pageParams`, `fetchNextPage` and `fetchPreviousPage`. A refetch from an interval, an invalidate or `refetch()` re-fetches every loaded page through `runRefetchAll`, not page one alone (T3.7). SSR, focus and reconnect refetch, `offlineFirst`, plugins and devtools all cover it (`../decisions/infinite-query-parity.md`). |
| `focus-online.ts` | The shared window-focus and `online` listeners: `subscribeWindowFocus`, `subscribeReconnect`. The plugin host's `network` reuses them. |
| `index.ts` | A barrel over `local.ts` and `types.ts`. Nothing imports it; the package index is `packages/core/src/index.ts`. |

## How a subscription is wired

```
createQuery(ctx, query, () => [id])     (bind.ts)
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

A `Query` is module-scoped. Binding a handle or entry registers its client in `query.__clients`, and indexes the query in the client's `byId` map (`client.ts:749-761`). Bound actions select that client; unbound calls fail when more than one client is registered. Disposal unregisters the client. See `../decisions/per-root-query-client.md` and `query-isolation.test.ts`.

`invalidate` and `invalidateAll` return a `Promise<void>` for the selected root. Fetch errors route to that root's `onError` as `kind: 'cache'` with `queryId` and `key` (`client.ts:1383-1410`). Ambiguity and root disposal reject. A subscriber-less entry is marked stale without refetching. See spec §5.7 and §21.5.

## The imperative surface: a read, and three kinds of write

Beyond `createQuery`, the handle carries the operations that reach a keyed entry from outside a subscription: `invalidate`, `invalidateAll`, `cancel`, `cancelAll`, `prefetch`, `peek`, `setData`, `write` and `replace` (`types.ts:321-427`, `actions.ts:24-69`). `InfiniteQuery` has the same set over pages.

- **`peek(...keyArgs): T | undefined`** (`client.peekData`, `client.ts:1481-1487`) is a synchronous read. It looks the entry up in `maps` **without** `bindEntry`, so a peek cannot mint the entry it asks about. It reads through `.peek()`, so it registers no reactive dependency. `undefined` conflates "no entry" with "not settled", deliberately: the caller that cares is guarding a write, and both answers mean *don't*. The bound handle reads only its selected root. An unbound peek returns undefined for zero clients and throws on multiple clients.
- **`write(...keyArgs, updater): void`** (`client.writeData`, `client.ts:1509-1541`) is a canonical patch: `Entry.setData(updater, { track: false })`, so no snapshot record and no `hasPendingMutations` flip. It rebases live snapshots onto the written value and leaves a fetch in flight alone. It binds the entry when absent, as `setData` does. Plugins and devtools see `source: 'write'`.
- **`replace(...keyArgs, value): void`** (`client.replaceData`, `client.ts:1560-1579`) is a canonical whole record. It writes like `write`, then cancels a fetch in flight when `value` is defined. The source is `'replace'`.
- **`setData(...keyArgs, updater): Snapshot`** (`client.setData`, `client.ts:1581-1623`) is the **optimistic** write, reported as `'optimistic'`. Its snapshot is the caller's to settle, and a rollback that changes the data reports a `'rollback'` write. See `pitfalls/no-invalidator-still-refetches.md` for the `cancel()`-first rule that applies to it even when nothing invalidates the query.

Why these are separate methods rather than options: `decisions/canonical-vs-optimistic-writes.md`.

## How mutations integrate with the cache

- `onMutate` typically calls `query.setData(...)`. That writes through `client.setData`, which calls `entry.setData(updater)`. The Entry records a snapshot (the pre-value) and returns `{ rollback, finalize }`.
- `onError(err, vars, snapshot)` typically calls `snapshot?.rollback()`, and the runner rolls back after `onError` anyway. On success the runner calls `finalize()` (`mutation.ts:556-561`). Rolling back the top-of-stack snapshot restores its captured pre-value. A non-top rollback under concurrency chain-splices instead, so out-of-order rollbacks still converge on the original value (spec §6.4, `entities/entry.md`).
- For `concurrency: 'latest-wins'`, the previous run's snapshot rolls back **synchronously before the new run's `onMutate` is called** (`mutation.ts:408-417`). See `pitfalls/latest-wins-rollback-order.md`.
- Mutation inflight is tracked centrally on `queryClient.mutationsInflight$`. `root.waitForIdle()` waits on it, on per-entry `isFetching`, and on work plugins `track`.

## Network mode & `isPaused`

`QuerySpec.networkMode` (`'online'` default, `'always'` and `'offlineFirst'`) gates fetches on `navigator.onLine`. `online` defers a fetch requested while offline in `Entry.scheduleDeferredFetch` (`entry.ts:223-239`). The entry resumes on the `online` event: `subscribeReconnect` in `focus-online.ts` calls `Entry.drainDeferred` (`entry.ts:241-260`). `offlineFirst` runs the fetch, but a `fetch` `TypeError` raised while offline parks and retries on reconnect instead of surfacing the error; see the `runWithRetry` catch in `entry.ts:297-308` (T3.5). Both parked paths set the `isPaused` signal on `AsyncState`. It is `true` while waiting for the network and `false` whenever a fetch is in flight or settled. `always` never parks. Spec §5.5; pinned by `query-focus-online.test.ts` (R-Q3.5). Infinite entries park the same way in both fetch loops, `runRefetchAll` and `runFetch`, through `parksOnOffline` and `settleParked` (`infinite.ts:953-958`). The drain re-runs the parked direction, and a parked refetch re-runs the whole refetch.

## SSR

`root.dehydrate()` calls `QueryClient.dehydrate` (`client.ts:1159-1186`). It walks `maps` and `infiniteMaps` and emits `{ id, key, data, lastUpdatedAt }` for each entry in `status: 'success'`, plus `pageParams` for an infinite entry. Error and idle entries are skipped.

`createRoot(def, { hydrate: state })` buffers the payload into the client's `hydratedData` map through `QueryClient.hydrate` (`client.ts:1084-1095`), keyed by query id and key hash. The first `bindEntry` matching both consumes the row and threads it into the new `Entry` as `initialData` (`client.ts:1286-1291`). That site also reports one `WriteEvent` with `source: 'hydrate'` (`client.ts:1322-1332`). Without it, a plugin observing every write, such as entities, would miss every hydrated row, because `Entry.applySuccess` never runs for an entry that starts with `initialData`. `bindInfiniteEntry` does the same for a payload with aligned `pageParams` (`client.ts:1642-1683`).

`root.hydrate(state)` and `host.queries.hydrate(state)` apply a payload to a running root through `hydrateLive` (`client.ts:1078-1081`), which checks the version and calls `applyDehydratedEntry` per row (`client.ts:1043-1071`). A bound entry takes the row through `Entry.applyHydration`, which supersedes a fetch in flight, and reports one `'hydrate'` write. An unbound key buffers into `hydratedData`. The React streaming hydrator feeds `root.hydrate` batch by batch. See `flows/ssr.md`.

## The plugin host's query half

The plugin contract is `plugin/types.ts` (`OlasPlugin`, `PluginHost`, `PluginHooks` and the event types), and the runtime is `PluginSet` in `plugin/host.ts`. `createRoot` runs each plugin's `setup(host)` once per root, before the root factory. The reasoning is `../decisions/plugin-host-v2.md`, and the end-to-end flow is `../flows/plugin-lifecycle.md`.

`QueryClient` implements the host's engine side, `PluginEngine` (`plugin/host.ts:26-29`):

- **`queryHost(origin)`** (`client.ts:852-889`) is `host.queries`. It addresses entries by query `id` and key through `byId`. `write` and `replace` go through `writeByKey` (`client.ts:954-987`), a canonical write that is a no-op when the root holds no entry for the key.
- **`mutationHost(origin)`** (`client.ts:892-901`) is `host.mutations`: `has`, `get` and `run` over the mutation registry. `run` keeps one runner per plugin and id (`client.ts:903-933`).
- **Emitters.** `emitWrite`, `emitInfiniteWrite`, `emitInvalidated`, `emitRemoved` and `emitActivity` (`client.ts:763-826`) build events only when a plugin listens for them.
- **Middleware.** `runFetch` (`client.ts:829-833`) sends each fetch attempt through `wrapFetch`, and `mutationLifecycle` (`client.ts:839-849`) hands the runner `onMutation` and `wrapMutate`.

Every write and invalidate carries an `origin`: the plugin's name for a host write, the `origin` given to `bindQuery(ctx, query, { origin })`, else `undefined` for the app. A hook throw reaches `onError` as `kind: 'plugin'` with `pluginName`. Canonical consumers: `modules/cross-tab.md`, `modules/entities.md`, `modules/mutation-queue.md` and `modules/persist.md`.

## Notable gotchas (full details in `../pitfalls/`)

- `callArgs` is forwarded to the fetcher; `keyArgs` is hashed. See `../pitfalls/callargs-vs-keyargs.md`.
- `isStale` is a `Signal` with a `setTimeout`, not a computed. See `../pitfalls/isstale-needs-timer.md`.
- Mutation `latest-wins` rollback ordering. See `../pitfalls/latest-wins-rollback-order.md`.
- Mutation's `raceAbort` defends against misbehaving mutate fns. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.

## Identity and lifetime guarantees

Bound query operations target one root; unbound calls fail if multiple roots have touched the definition. Every shared query has a hand-written `id`, which SSR payloads, plugins, devtools and error contexts all name it by. Cache keys tag every value recursively, so user strings and objects cannot imitate the special values. Stale, gc and interval timers skip `Infinity` and split long finite delays into platform-safe chunks (`expiry-timer.ts`). See `query-isolation.test.ts`, `cache-identity.test.ts`, `expiry-timers.test.ts` and spec §21.5.
