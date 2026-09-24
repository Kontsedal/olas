---
name: query-client
description: Per-root entry registry. Owns the maps, gcTime, mutationsInflight$, dehydrate/hydrate/waitForIdle.
type: entity
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/query/focus-online.ts
  - packages/core/src/plugin/host.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-focus-online.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-default-options.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: uses, target: entry.md }
  - { type: uses, target: ../decisions/per-root-query-client.md }
  - { type: related, target: ../pitfalls/callargs-vs-keyargs.md }
  - { type: uses, target: ../decisions/canonical-vs-optimistic-writes.md }
last_verified: 2026-09-24
confidence: high
---

# `QueryClient`

One per root (`createRoot` instantiates it; the root's `dispose` disposes it). Holds the entry registry, GC timers, refetch-interval timers, mutation-inflight counter, and the dehydrate/hydrate/waitForIdle implementations. Spec §5.1, §21.4, §21.5.

## Two maps, two entry types

```ts
maps:         Map<AnyQuery,         Map<keyHash, ClientEntry<T>>>
infiniteMaps: Map<AnyInfiniteQuery, Map<keyHash, InfiniteClientEntry>>
```

Why two? Regular and infinite queries differ enough (single `data` vs array of `pages`, `fetchNextPage` mechanic) that a unified entry would be more confusing than two parallel paths. They share the AsyncState shape via `Entry`/`InfiniteEntry`'s common signals.

## Root-wide query defaults

`client.defaults: DefaultQueryOptions` holds `RootOptions.defaultQueryOptions` (always an object, never `undefined`, so call sites stay a flat `??` chain). Spec §5.9.

Every consumer resolves the same way — **`spec.X ?? client.defaults.X ?? built-in`**, so an explicit per-query field always wins:

| Field | Resolved in |
|---|---|
| `staleTime`, `retry`, `retryDelay`, `networkMode`, `structuralShare` | `ClientEntry` ctor → `Entry` options (`client.ts:155-169`); `InfiniteClientEntry` ctor → `InfiniteEntry` (`client.ts:402-418`) |
| `gcTime` | `ClientEntry` / `InfiniteClientEntry` fields (`client.ts:143`, `client.ts:394`) |
| `keepPreviousData` | `createUse` / `createInfiniteUse` (`use.ts:149`, `use.ts:396`) — it lives on the subscription, not the entry |
| `refetchOnWindowFocus`, `refetchOnReconnect` | folded into `client.refetchOnWindowFocus` / `client.refetchOnReconnect` at construction; see above |
| `staleTime`, `keepPreviousData` (for `createCache`) | `instance.ts` `cache()` merges them into `LocalCacheOptions` before `createLocalCache` |

Two asymmetries worth knowing:

- **`refetchInterval` is not defaultable** — a root-wide interval would silently poll every query in the app. Same reasoning keeps it off `UseOptions`: the timer is per **entry**, so a per-subscriber interval would need a "whose interval wins" rule.
- **`refetchOnWindowFocus` and `refetchOnReconnect` apply to infinite queries too.** `InfiniteClientEntry` subscribes on its first `acquire` like `ClientEntry`, and a focus or reconnect refetch re-fetches every loaded page (1.0; `../decisions/infinite-query-parity.md`).
- **`createCache` only gets `staleTime` and `keepPreviousData`**, because those are the only fields `LocalCacheOptions` carries — `retry`, `gcTime` and `networkMode` aren't part of its surface.

## ClientEntry vs Entry

`Entry<T>` is the state machine. `ClientEntry<T>` wraps it and adds the **per-root** stuff:

- `subscriberCount` — incremented by `acquire()`, decremented by `release()`.
- `gcTimer` — started on `release()` when the count hits zero, and by `scheduleGcIfOrphan()` for entries created by a non-subscribing path such as `prefetch`, `setData` or `invalidate`. `acquire()` clears it. It fires `client.dropEntry(this)`. Since 0.9 it holds a **cancellation closure** from `scheduleExpiry` in `expiry-timer.ts` rather than a raw handle. So `gcTime: Infinity` schedules nothing and retains the entry for the life of the root, and a `gcTime` past 2,147,483,647 ms is chunked instead of overflowing. Before that both clamped to about 1ms and collected almost immediately, the exact opposite of the setting. Shared with the staleness timer; see `../pitfalls/isstale-needs-timer.md` and `packages/core/tests/expiry-timers.test.ts`. A `release()` after the entry was disposed is a no-op (1.0): a `prefetch` still in flight at `root.dispose()` releases in its `finally`, and that used to arm a fresh gc timer for a dead entry, which held a Node process open for `gcTime`.
- `intervalTimer` — a self-rescheduling `setTimeout` chain (`client.ts:259-310`), not a `setInterval`. Each tick **re-arms first**, then runs two guards. It skips while `document.visibilityState === 'hidden'`. It also skips while a fetch is in flight, per `isFetching.peek()`, so the tick joins the running fetch rather than aborting it and a fetch slower than the interval cannot livelock (T3.2). Re-arm-before-guards is load-bearing twice over. It keeps the cadence a metronome, measuring gap N+1 from tick N rather than from whenever the fetch settles. It also stops a skipped tick from ending the chain forever. Pinned in `regressions.test.ts` under R-Q3.2 and in `query-focus-online.test.ts`'s "refetchInterval — hidden tab".
- `nextIntervalMs` — the closure that resolves the gap for the next tick, `undefined` when the query declared no `refetchInterval`. `refetchInterval` is `number | ((data: T | undefined) => number)` per spec §5.9. The function form is called on every scheduling decision with `entry.data.peek()`, which is non-subscribing and so cannot become a reactive dependency. It is held as a closure rather than as a `RefetchInterval<T>` field, because a `(data: T) => number` member puts `T` in a contravariant position and makes `ClientEntry<T>` invariant. That would break every `ClientEntry<unknown>` boundary in the file, including the maps and `dropEntry`. A resolved gap that is not a positive finite number stops the chain and dev-warns, in `resolveRefetchInterval` at `client.ts:30-82`, rather than spinning a `setTimeout(…, 0)` hot loop. Because the rule is written against the *resolved* gap it binds a numeric literal too, so `refetchInterval: 0` no longer arms at all. It used to mean "fetch every macrotask" via `setInterval`'s clamp. A thunk that **throws** takes the same path, with a warning that names the throw and carries the error. The data read is passed in as a thunk so it happens inside that same try, because the resolution runs before the re-arm and anything non-total there would end polling permanently. Recovery is only the entry's next **0→1 acquire**: a subscriber joining an entry that still has others does not re-arm it, and the warning string says so. Bad literal, bad return and throw are all pinned in `query.test.ts` under `refetchInterval`.
- `unsubFocus` or `unsubOnline` — `window` focus and `online` subscriptions, installed on the 0→1 acquire transition when the resolved flag is `true`. Resolution: `spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus ?? false` (and same for reconnect) — per-query spec wins, root-wide default fills in, otherwise off. `client.refetchOnWindowFocus` itself resolves at construction as `defaultQueryOptions.refetchOnWindowFocus ?? opts.refetchOnWindowFocus ?? false` (`client.ts:589-593`) — the dedicated `defaultQueryOptions` slot beats the older flat shorthand. Cleared on release-to-zero and on dispose. The handler skips refetch if `entry.isStaleNow()` is false, so a freshly-fetched query within `staleTime` ignores the focus event. The window/document listeners themselves live in `query/focus-online.ts` as a lazy single-listener pubsub, shared across all clients and SSR-safe. The fan-out follows DOM dispatch rules (1.0): it calls the subscribers present when the event fired, so one added during a dispatch waits for the next event, and one removed before its turn is skipped. It used to iterate the live `Set`. An entry parked offline re-subscribes from inside its own handler, so one `online` event that arrived while `navigator.onLine` still read false spun synchronously without end. Pinned by `query-focus-online.test.ts`, "reconnect dispatch".
- `callArgs` and `keyArgs` — separately stored. `callArgs` is fed to the fetcher. `keyArgs = spec.key(...callArgs)` is hashed for identity. See `../pitfalls/callargs-vs-keyargs.md`.

## Cross-root query operation

A `Query` is module-scoped, but imperative operations select a root with `bindQuery(ctx, query)` or `root.bindQuery(query)`. The typed action handle routes only to that client and checks disposal on every call. Binding either a handle or an entry registers the client in `query.__clients`; disposal unregisters it. Unbound methods use the sole registered client, and reject/throw before doing work when multiple clients are registered. With zero clients, prefetch rejects and other operations retain their no-op/undefined behavior. See `../decisions/per-root-query-client.md` and `packages/core/tests/query-isolation.test.ts`.

Two of these deliberately do **not** go through `bindEntry`. `peekData` stays out because a read must not create the entry it reports on. `cancel` and `invalidate` stay out because there is nothing to cancel or invalidate when no entry exists. `writeData` and `setData` do bind — see `../decisions/canonical-vs-optimistic-writes.md` for why `write` matches `setData` here rather than `setEntryData`.

## Mutation inflight counter

`mutationsInflight$: Signal<number>` lives on the client (not on individual mutations). `MutationImpl` receives a reference and `.update(n => n+1)` on each `executeRun` start, `.update(n => n-1)` on settle (in `finally`). `waitForIdle()` waits for this AND for all per-entry `isFetching` flags. Counter signal at `client.ts:541`; `waitForIdle` at `client.ts:1040-1071`.

## SSR

`dehydrate()`: iterate `maps` and `infiniteMaps`, emit `{ id: query.__id, key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'`, plus `pageParams` for an infinite entry. Error and idle entries are skipped. Spec §15. `hydrate(state)` populates `hydratedData: Map<keyHash, { data, lastUpdatedAt }>`. `bindEntry` checks `hydratedData` on first bind for a key and threads the values into the new Entry's `initialData` and `initialUpdatedAt`. Consumed once — subsequent rebinds refetch normally. See `../flows/ssr.md`.

## What `dispose()` does

Disposes every `ClientEntry`/`InfiniteClientEntry` (clearing their timers and aborting their Entry). Clears both maps and `hydratedData`. Removes the client from every touched query's `__clients` set. Calls each plugin's `dispose()` (try/catch-wrapped). Sets `disposed: true`.

## Plugins

`QueryClient` accepts `plugins?: QueryClientPlugin[]` (forwarded from `RootOptions.plugins`; spec §13.2). At construction, every plugin's `init(api)` is invoked with a `QueryClientPluginApi` view that closes over the client. The client then fires `onSetData`, `onInvalidate` or `onGc` for every cache mutation against a query with a `queryId` set:

- `onSetData` — `setData` and `setInfiniteData`. `event.kind === 'data'` for regular queries; `'infinite'` for paginated. `event.isRemote === true` when `applyRemoteSetData` caused the write, so plugins skip rebroadcast. `client.setData` and `setInfiniteData` also **re-emit on `snapshot.rollback()`**, with `source: 'set'` and the restored value. The re-emit is guarded on an actual data change, so a non-top chain-splice rollback is a no-op. Cross-tab and entity peers then drop the failed optimistic state (T3.6).
- `onInvalidate` — `invalidate`, `invalidateAll`, `invalidateInfinite`, `invalidateAllInfinite`. Same `isRemote` semantics. All four route the entry through `client.invalidateEntry`. If it `hasSubscribers()`, the entry is marked stale and refetched. Otherwise only `entry.markStale()` runs, and the next subscriber refetches (spec §5.7, T3.9). `markStale` sets a `forcedStale` flag that keeps `isStaleNow()` true until the next successful fetch clears it. `invalidateEntry` returns a `Promise<void>` that resolves when the triggered refetch settles, or immediately when the entry is subscriber-less. The four public methods aggregate those with `Promise.all`, so `query.invalidate(...)` and `invalidateAll()` are **awaitable** and do not reject. Errors go to `onError` (spec §5.7).
- `onGc` — `dropEntry`, `dropInfiniteEntry`. No `isRemote` (gc is local-only).

Plugin api:

- `applyRemoteSetData(queryId, keyArgs, data)` — resolves the query via the `queryId` registry in `plugin.ts`. No-op when no local entry exists for that key (no `callArgs` available to refetch later, and seeding rows the user never subscribed to would be leaky). Sets `applyingRemote = true` while the underlying `Entry.setData` runs; `emitSetData` reads the flag for the `isRemote` field. Infinite queries are dropped silently (deferred for v1 cross-tab).
- `applyRemoteInvalidate(queryId, keyArgs)` — same shape, invalidates the local entry if present.
- `setEntryData(queryId, keyArgs, updater)` — local-originated write keyed by `(queryId, keyArgs)`. Routes regular queries through `Entry.setData` and infinite queries through `InfiniteEntry.setData` (the `data` on the resulting `SetDataEvent` is `TPage[]` for infinite, matching `kind: 'infinite'`). Used by the `@kontsedal/olas-entities` plugin to backpropagate entity patches into every query holding the entity — including paginated/infinite ones — without forcing the plugin to recover the original `callArgs`. Emits with `isRemote: false`, `source: 'set'`; cross-tab WILL rebroadcast.
- `subscribedKeys(queryId)` — walks the client's `maps` (or `infiniteMaps`) for the matching query and returns every bound entry's `keyArgs`. Used by cross-tab plugins to scope outbound traffic. Returns `[]` for unknown `queryId`s.

Every plugin callback is wrapped in try/catch — exceptions go through `dispatchError(this.onError, err, { kind: 'plugin' })`. A plugin bug never tears down the cache. The `'plugin'` kind is new in `ErrorContext` (§20.9) — pre-existing `cache` and `mutation` semantics unchanged.

Infinite-query plugin events fire with `kind: 'infinite'` for forward compatibility. They fire on every successful page settle, whether initial, next or previous, via `InfiniteClientEntry`'s `onSuccessData` closure. They also fire on every `setInfiniteData` and `setEntryData` write that targets an infinite query. The current `@kontsedal/olas-cross-tab` plugin filters them out, a v1 limitation noted in §13.2. `@kontsedal/olas-entities` consumes them to walk infinite-query payloads for backprop.
