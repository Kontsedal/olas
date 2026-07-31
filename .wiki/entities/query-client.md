---
name: query-client
description: Per-root entry registry. Owns the maps, gcTime, mutationsInflight$, dehydrate/hydrate/waitForIdle.
type: entity
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/query/focus-online.ts
  - packages/core/src/query/plugin.ts
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
last_verified: 2026-07-31
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
| `staleTime`, `keepPreviousData` (for `ctx.cache`) | `instance.ts` `cache()` merges them into `LocalCacheOptions` before `createLocalCache` |

Two asymmetries worth knowing:

- **`refetchInterval` is not defaultable** — a root-wide interval would silently poll every query in the app. Same reasoning keeps it off `UseOptions`: the timer is per **entry**, so a per-subscriber interval would need a "whose interval wins" rule.
- **`refetchOnWindowFocus` / `refetchOnReconnect` are no-ops for infinite queries.** `InfiniteClientEntry` installs no focus/online subscription at all, so those fields aren't threaded there (comment at the ctor records this).
- **`ctx.cache` only gets `staleTime` / `keepPreviousData`**, because those are the only fields `LocalCacheOptions` carries — `retry` / `gcTime` / `networkMode` aren't part of its surface.

## ClientEntry vs Entry

`Entry<T>` is the state machine. `ClientEntry<T>` wraps it and adds the **per-root** stuff:

- `subscriberCount` — incremented by `acquire()`, decremented by `release()`.
- `gcTimer` — started on `release()` when count hits zero; cleared on `acquire()`. Fires `client.dropEntry(this)`.
- `intervalTimer` — a self-rescheduling `setTimeout` chain (`client.ts:259-310`), not a `setInterval`. Each tick **re-arms first**, then runs the two guards: skip while `document.visibilityState === 'hidden'`, and skip while a fetch is in flight (`isFetching.peek()`) so the tick joins the running fetch rather than aborting it — a fetch slower than the interval can't livelock (T3.2). Re-arm-before-guards is load-bearing twice over: it keeps the cadence a metronome (gap N+1 measured from tick N, not from whenever the fetch settles) and it stops a skipped tick from ending the chain forever. Pinned in `regressions.test.ts` under R-Q3.2 and in `query-focus-online.test.ts`'s "refetchInterval — hidden tab".
- `nextIntervalMs` — the closure that resolves the gap for the next tick, `undefined` when the query declared no `refetchInterval`. `refetchInterval` is `number | ((data: T | undefined) => number)` (spec §5.9); the function form is called on every scheduling decision with `entry.data.peek()` — non-subscribing, so it can't become a reactive dependency. Held as a closure rather than as a `RefetchInterval<T>` field because a `(data: T) => number` member puts `T` in a contravariant position and makes `ClientEntry<T>` invariant, which breaks every `ClientEntry<unknown>` boundary in the file (the maps, `dropEntry`). A resolved gap that isn't a positive finite number stops the chain and dev-warns (`resolveRefetchInterval`, `client.ts:30-82`) rather than spinning a `setTimeout(…, 0)` hot loop — and because the rule is written against the *resolved* gap, it binds a numeric literal too: `refetchInterval: 0` no longer arms at all (it used to mean "fetch every macrotask" via `setInterval`'s clamp). A thunk that **throws** takes the same path, with a warning that names the throw and carries the error; the data read is passed in as a thunk so it happens inside that same try, since the resolution runs before the re-arm and anything non-total there would end polling permanently. Recovery is only the entry's next **0→1 acquire** — a subscriber joining an entry that still has others does not re-arm it, and the warning string says so. All three cases (bad literal, bad return, throw) are pinned in `query.test.ts` under `refetchInterval`.
- `unsubFocus` / `unsubOnline` — `window` focus and `online` subscriptions, installed on the 0→1 acquire transition when the resolved flag is `true`. Resolution: `spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus ?? false` (and same for reconnect) — per-query spec wins, root-wide default fills in, otherwise off. `client.refetchOnWindowFocus` itself resolves at construction as `defaultQueryOptions.refetchOnWindowFocus ?? opts.refetchOnWindowFocus ?? false` (`client.ts:589-593`) — the dedicated `defaultQueryOptions` slot beats the older flat shorthand. Cleared on release-to-zero and on dispose. The handler skips refetch if `entry.isStaleNow()` is false, so a freshly-fetched query within `staleTime` ignores the focus event. The window/document listeners themselves live in `query/focus-online.ts` as a lazy single-listener pubsub, shared across all clients and SSR-safe.
- `callArgs` and `keyArgs` — separately stored. `callArgs` is fed to the fetcher. `keyArgs = spec.key(...callArgs)` is hashed for identity. See `../pitfalls/callargs-vs-keyargs.md`.

## Cross-root query operation

A `Query` is module-scoped. When `bindEntry` runs on this client for that query, the client adds itself to `query.__clients`. On dispose, the client removes itself from every `touchedQueries`. So `query.invalidate(...)` reaches exactly the live clients, no GC concerns. The same fan-out serves `setData`, `cancel` / `cancelAll` (→ `client.cancel`/`cancelAll` → `entry.cancel`, T3.4), and `prefetch`. See `../decisions/per-root-query-client.md`.

## Mutation inflight counter

`mutationsInflight$: Signal<number>` lives on the client (not on individual mutations). `MutationImpl` receives a reference and `.update(n => n+1)` on each `executeRun` start, `.update(n => n-1)` on settle (in `finally`). `waitForIdle()` waits for this AND for all per-entry `isFetching` flags. Counter signal at `client.ts:541`; `waitForIdle` at `client.ts:1040-1071`.

## SSR

`dehydrate()`: iterate `maps`, emit `{ key: keyArgs, data, lastUpdatedAt }` for entries in `status: 'success'`. Skip infinite queries and error/idle. `hydrate(state)` populates `hydratedData: Map<keyHash, { data, lastUpdatedAt }>`. `bindEntry` checks `hydratedData` on first bind for a key and threads the values into the new Entry's `initialData` / `initialUpdatedAt`. Consumed once — subsequent rebinds refetch normally. See `../flows/ssr.md`.

## What `dispose()` does

Disposes every `ClientEntry`/`InfiniteClientEntry` (clearing their timers and aborting their Entry). Clears both maps and `hydratedData`. Removes the client from every touched query's `__clients` set. Calls each plugin's `dispose()` (try/catch-wrapped). Sets `disposed: true`.

## Plugins

`QueryClient` accepts `plugins?: QueryClientPlugin[]` (forwarded from `RootOptions.plugins`; spec §13.2). At construction, every plugin's `init(api)` is invoked with a `QueryClientPluginApi` view that closes over the client. The client then fires `onSetData` / `onInvalidate` / `onGc` for every cache mutation against a query with a `queryId` set:

- `onSetData` — `setData` and `setInfiniteData`. `event.kind === 'data'` for regular queries; `'infinite'` for paginated. `event.isRemote === true` when the write was caused by `applyRemoteSetData` (so plugins skip rebroadcast). `client.setData`/`setInfiniteData` also **re-emit on `snapshot.rollback()`** with `source: 'set'` + the restored value (guarded on an actual data change, so a non-top chain-splice rollback is a no-op) — cross-tab / entity peers drop the failed optimistic state (T3.6).
- `onInvalidate` — `invalidate`, `invalidateAll`, `invalidateInfinite`, `invalidateAllInfinite`. Same `isRemote` semantics. All four route the entry through `client.invalidateEntry`: if it `hasSubscribers()` → mark stale + refetch; otherwise → `entry.markStale()` only (the next subscriber refetches, spec §5.7, T3.9). `markStale` sets a `forcedStale` flag that keeps `isStaleNow()` true until the next successful fetch clears it.
- `onGc` — `dropEntry`, `dropInfiniteEntry`. No `isRemote` (gc is local-only).

Plugin api:

- `applyRemoteSetData(queryId, keyArgs, data)` — resolves the query via the `queryId` registry in `plugin.ts`. No-op when no local entry exists for that key (no `callArgs` available to refetch later, and seeding rows the user never subscribed to would be leaky). Sets `applyingRemote = true` while the underlying `Entry.setData` runs; `emitSetData` reads the flag for the `isRemote` field. Infinite queries are dropped silently (deferred for v1 cross-tab).
- `applyRemoteInvalidate(queryId, keyArgs)` — same shape, invalidates the local entry if present.
- `setEntryData(queryId, keyArgs, updater)` — local-originated write keyed by `(queryId, keyArgs)`. Routes regular queries through `Entry.setData` and infinite queries through `InfiniteEntry.setData` (the `data` on the resulting `SetDataEvent` is `TPage[]` for infinite, matching `kind: 'infinite'`). Used by the `@kontsedal/olas-entities` plugin to backpropagate entity patches into every query holding the entity — including paginated/infinite ones — without forcing the plugin to recover the original `callArgs`. Emits with `isRemote: false`, `source: 'set'`; cross-tab WILL rebroadcast.
- `subscribedKeys(queryId)` — walks the client's `maps` (or `infiniteMaps`) for the matching query and returns every bound entry's `keyArgs`. Used by cross-tab plugins to scope outbound traffic. Returns `[]` for unknown `queryId`s.

Every plugin callback is wrapped in try/catch — exceptions go through `dispatchError(this.onError, err, { kind: 'plugin' })`. A plugin bug never tears down the cache. The `'plugin'` kind is new in `ErrorContext` (§20.9) — pre-existing `cache` / `mutation` semantics unchanged.

Infinite-query plugin events fire with `kind: 'infinite'` for forward compatibility — on every successful page settle (initial, next, prev) via `InfiniteClientEntry`'s `onSuccessData` closure, and on every `setInfiniteData` / `setEntryData` write that targets an infinite query. The current `@kontsedal/olas-cross-tab` plugin filters them out (§13.2 v1 limitation), but `@kontsedal/olas-entities` consumes them to walk infinite-query payloads for backprop.
