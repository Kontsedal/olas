---
name: query-client
description: The per-root cache engine. Owns the entry maps, the per-root query-id index, gc and interval timers, mutationsInflight$, dehydrate/hydrate/waitForIdle, and the engine half of the plugin host.
type: entity
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/query/engine.ts
  - packages/core/src/query/actions.ts:10-18
  - packages/core/src/query/focus-online.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-focus-online.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-default-options.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query-isolation.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: uses, target: entry.md }
  - { type: uses, target: ../decisions/per-root-query-client.md }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: related, target: ../pitfalls/callargs-vs-keyargs.md }
  - { type: uses, target: ../decisions/canonical-vs-optimistic-writes.md }
last_verified: 2026-09-25
confidence: high
---

# `QueryClient`

One per root. `queryEngine()` is a definition, and each root that adopts it gets its own client through `QueryEngineInternals.create` (`packages/core/src/query/engine.ts:87-104`). `createRoot` creates the client eagerly, before plugin setup and the factory, and the root's `dispose` disposes it last. The client holds the entry registry, the gc and refetch-interval timers, the mutation in-flight counter, the dehydrate, hydrate and `waitForIdle` implementations, and the engine half of the plugin host. Spec §5.1, §21.4, §21.5.

## Two maps, two entry types

```ts nocheck
maps:         Map<AnyQuery,         Map<keyHash, ClientEntry<T>>>
infiniteMaps: Map<AnyInfiniteQuery, Map<keyHash, InfiniteClientEntry>>
byId:         Map<queryId, AnyQuery | AnyInfiniteQuery>   // this root's queries
```

The fields are at `packages/core/src/query/client.ts:851-870`. Regular and infinite queries differ enough, one `data` against an array of `pages` with a paging mechanic, that a unified entry would be more confusing than two parallel paths. They share the `AsyncState` shape through `Entry` and `InfiniteEntry`'s common signals.

`byId` holds the queries this root has bound, by `id` (`client.ts:859-865`). `index()` fills it on the first `bindEntry`, `bindInfiniteEntry` or `bindQuery` of a query, and warns in development when two different query values share an id in one root (`client.ts:928-941`). Plugins, hydration payloads and devtools address queries through it. A duplicate id is therefore a collision within one app, never across the process. Pinned by `plugin-host.test.ts`, "two queries sharing an id in one root warn in dev".

## Root-wide query defaults

`client.defaults: QueryDefaults` holds `queryEngine({ defaults })`, always an object and never `undefined`, so call sites stay a flat `??` chain (`client.ts:885-891`, `client.ts:907`). Spec §5.9.

Every consumer resolves the same way, **`spec.X ?? client.defaults.X ?? built-in`**, so an explicit per-query field wins:

| Field | Resolved in |
|---|---|
| `staleTime`, `retry`, `retryDelay`, `networkMode`, `structuralShare` | `ClientEntry` constructor → `Entry` options (`client.ts:402-406`); `InfiniteClientEntry` constructor → `InfiniteEntry` (`client.ts:671-675`) |
| `gcTime` | `ClientEntry` and `InfiniteClientEntry` fields (`client.ts:383`, `client.ts:652`) |
| `keepPreviousData` | `createUse` and `createInfiniteUse` (`packages/core/src/query/use.ts:253`, `use.ts:563`); it lives on the subscription, not the entry |
| `refetchOnWindowFocus`, `refetchOnReconnect` | folded into `client.refetchOnWindowFocus` and `client.refetchOnReconnect` at construction (`client.ts:908-909`) |
| `staleTime`, `keepPreviousData` (for `createCache`) | `createCache` merges them into `LocalCacheOptions` from `CtxInternals.queryDefaults` (`packages/core/src/query/bind.ts:111-121`), so a local cache never loads the client |

Three asymmetries worth knowing:

- **`refetchInterval` is not defaultable.** A root-wide interval would poll every query in the app without anyone asking. The same reasoning keeps it off `QuerySubscriptionOptions`: the timer is per **entry**, so a per-subscriber interval would need a rule for whose interval wins.
- **`refetchOnWindowFocus` and `refetchOnReconnect` apply to infinite queries too.** `InfiniteClientEntry` subscribes on its first `acquire` like `ClientEntry`, and a focus or reconnect refetch re-fetches every loaded page (1.0; `../decisions/infinite-query-parity.md`).
- **`createCache` gets only `staleTime` and `keepPreviousData`**, because those are the only fields `LocalCacheOptions` carries. `retry`, `gcTime` and `networkMode` are not part of its surface.

## ClientEntry vs Entry

`Entry<T>` is the state machine. `ClientEntry<T>` wraps it and adds the **per-root** parts (`client.ts:328-608`):

- `subscriberCount` — `acquire()` increments it and `release()` decrements it. The 0→1 and 1→0 transitions call `emitActivity`, which reports `onActivate` and `onDeactivate` to plugins (`client.ts:419-467`). It counts every hold, a prefetch in flight included, because it drives gc.
- `subscriptions` — the holds that are controller subscriptions (1.0). `acquire(subscriberPath)` and `release(subscriberPath)` move it when given a path, which `createUse` always passes and a prefetch never does. Each such call emits the devtools `cache:subscribed` or `cache:unsubscribed` with the path, and `queryEntriesSnapshot` reports the count as `DebugCacheEntry.subscribers`. See `../modules/devtools.md`.
- `gcTimer` — started on `release()` when the count hits zero, and by `scheduleGcIfOrphan()` for an entry a non-subscribing path created, such as `prefetch`, `setData` or `invalidate`. `acquire()` clears it, and it fires `client.dropEntry(this)`. Since 0.9 it holds a **cancellation closure** from `scheduleExpiry` in `expiry-timer.ts` rather than a raw handle. So `gcTime: Infinity` schedules nothing and keeps the entry for the life of the root, and a `gcTime` past 2,147,483,647 ms is chunked instead of overflowing. Before that, both clamped to about 1 ms and collected almost at once, the opposite of the setting. The staleness timer shares the helper; see `../pitfalls/isstale-needs-timer.md` and `packages/core/tests/expiry-timers.test.ts`.
  - A `release()` on a closing client arms no timer, because it returns on `client.isClosing` (1.0, `client.ts:455-457`). `root.dispose()` calls `queryClient.close()` before disposing the controllers, whose subscriptions then release entries the client disposes next.
  - A `release()` after the entry was disposed is a no-op (1.0, `client.ts:444`). A `prefetch` still in flight at `root.dispose()` releases in its `finally`. That release used to arm a fresh gc timer for a dead entry, which held a Node process open for `gcTime`.
- `intervalTimer` — a self-rescheduling `scheduleExpiry` chain, not a `setInterval` (`client.ts:478-541`). Each tick **re-arms first**, then runs two guards. It skips while `document.visibilityState === 'hidden'`. It also skips while a fetch is in flight, per `isFetching.peek()`, so the tick joins the running fetch rather than aborting it. A fetch slower than the interval therefore cannot livelock (T3.2). For a fetch parked for the network, per `isPaused.peek()`, it starts nothing and calls `entry.resumeParked()`, which runs the park only while `navigator.onLine` does not read false. An offline tick therefore parks no new waiter, and a park the `online` event missed still ends on the next tick (1.0, second pass). Before, the tick skipped a parked entry outright, and one with no `window` or an early `online` event stayed parked. Re-arming before the guards matters twice. It keeps the cadence a metronome, measuring gap N+1 from tick N rather than from whenever the fetch settles. It also stops a skipped tick from ending the chain. Pinned in `regressions.test.ts` under R-Q3.2 and in `query-focus-online.test.ts`'s "refetchInterval — hidden tab".
- `nextIntervalMs` — the closure that resolves the gap before the next tick, `undefined` when the query declared no `refetchInterval` (`client.ts:350-360`, `client.ts:384-388`). `refetchInterval` is `number | ((data: T | undefined) => number)` per spec §5.9.
  - The function form is called on every scheduling decision with `entry.data.peek()`, which does not subscribe and so cannot become a reactive dependency.
  - It is held as a closure rather than as a `RefetchInterval<T>` field. A `(data: T) => number` member puts `T` in a contravariant position and makes `ClientEntry<T>` invariant, which would break every `ClientEntry<unknown>` boundary in the file, including the maps and `dropEntry`.
  - `resolveRefetchInterval` (`client.ts:69-100`) stops the chain and dev-warns on a resolved gap that is not a positive finite number, rather than spinning a `setTimeout(…, 0)` hot loop. The rule binds the *resolved* gap, so `refetchInterval: 0` does not arm at all. It used to mean "fetch every macrotask" through `setInterval`'s clamp.
  - A thunk that **throws** takes the same path, with a warning that names the throw. The data read is passed as a thunk so it runs inside that same `try`. The resolution runs before the re-arm, so a throw there would end polling for good.
  - Recovery is only the entry's next **0→1 acquire**: a subscriber joining an entry that still has others does not re-arm it, and the warning says so. The bad literal, the bad return and the throw are pinned in `query.test.ts` under `refetchInterval`.
- `unsubFocus` and `unsubOnline` — `window` focus and `online` subscriptions, installed on the 0→1 acquire when the resolved flag is `true` (`client.ts:428-433`). The resolution is `spec.refetchOnWindowFocus ?? client.refetchOnWindowFocus`, and the same for reconnect, where the client's value is `defaults.refetchOnWindowFocus ?? false` (`client.ts:908-909`). They are cleared on release to zero and on dispose. The handler skips the refetch when `entry.isStaleNow()` is false, so a query fetched within `staleTime` ignores the event, and it joins a fetch already in flight (`client.ts:581-596`). For a parked entry it calls `entry.resumeParked()` instead, whatever the staleness, and starts no fetch of its own. The entry's reconnect listener drains through the same method, so whichever fires first runs the one request, and the other finds nothing parked. Starting a fetch here as well used to make one `online` event start a request and then abort it for a second. Pinned by `query-focus-online.test.ts`, "offline and reconnect scheduling".
  - The `window` and `document` listeners live in `query/focus-online.ts` as a lazy single-listener pubsub, shared across all clients, SSR-safe, and shared with `host.network`.
  - The fan-out follows DOM dispatch rules (1.0). It calls the subscribers present when the event fired, so one added during a dispatch waits for the next event, and one removed before its turn is skipped. It used to iterate the live `Set`. An entry parked offline re-subscribes from inside its own handler, so one `online` event that arrived while `navigator.onLine` still read false spun without end. Pinned by `query-focus-online.test.ts`, "reconnect dispatch".
- `callArgs` and `keyArgs` — stored separately. The fetcher receives `callArgs`, and `keyArgs = spec.key(...callArgs)` is hashed for identity. See `../pitfalls/callargs-vs-keyargs.md`. A later bind of the same key with other call args dev-warns, because the fetcher keeps the first bind's. `sameCallArg` (`client.ts:151-190`) compares plain objects and arrays structurally, a `Date` by its time, and anything else by identity, with `NaN` equal to `NaN`. It does no JSON normalization, so args that only the key hash makes equal warn, such as `{ max: Infinity }` and `{ max: -Infinity }` (1.0, second pass). It compared by `stableHash` before, and such a collision dropped the second bind's args in silence. A cycle ends through a map of the pairs under comparison, and a throw counts as different. `describeKey` (`client.ts:197-205`) prints a bigint as `1n` rather than throwing. Pinned by `cache-identity.test.ts`, "the diverging-callArgs warning".

Both entry kinds call their fetcher through `client.runFetch`, which runs the plugins' `wrapFetch` chain (`client.ts:398-401`, `client.ts:662-666`, `client.ts:1022-1026`).

## Cross-root query operation

A `Query` is module-scoped, and imperative operations pick a root with `bindQuery(ctx, query)` or `root.bindQuery(query)` (`client.ts:1508-1535`). The typed action handle routes only to that client and checks disposal on every call. Binding a handle or an entry registers the client in `query.__clients`, and `dispose` removes it. An unbound method uses the sole registered client, and throws before doing any work when more than one is registered (`packages/core/src/query/actions.ts:10-18`). With no client, `prefetch` rejects and the other operations do nothing or return `undefined`. See `../decisions/per-root-query-client.md` and `packages/core/tests/query-isolation.test.ts`.

Two operations deliberately do **not** go through `bindEntry`. `peekData` stays out because a read must not create the entry it reports on. `cancel` and `invalidate` stay out because nothing exists to cancel or invalidate when no entry exists. `writeData` and `setData` do bind; see `../decisions/canonical-vs-optimistic-writes.md` for why `write` matches `setData` here rather than `host.queries.write`.

## Invalidation

`invalidate`, `invalidateAll`, `invalidateInfinite`, `invalidateAllInfinite` and `host.queries.invalidate` all route the entry through `invalidateEntry` (`client.ts:1651-1687`):
- An entry that `hasSubscribers()` is marked stale and refetched.
- Otherwise only `entry.markStale()` runs, and the next subscriber refetches (spec §5.7, T3.9). `markStale` sets a `forcedStale` flag that keeps `isStaleNow()` true until data requested after it lands: a fetch started after it, or a hydrated row stamped after it. A fetch already running when the invalidation came does not clear it (`../entities/entry.md`).

`invalidateEntry` returns a `Promise<void>` that resolves when the triggered refetch settles, or at once for an entry without subscribers. The four public methods combine those with `Promise.all`, so `query.invalidate(...)` and `invalidateAll()` are **awaitable** and do not reject. A fetch error goes to `onError` as `{ kind: 'cache', queryId, key, attempt, cause? }`, with `attempt` and `cause` from `entry.failureOf(err)`, and an abort is dropped. Each invalidation then reports `onInvalidate` with the caller's origin, and the host's `invalidate` also sends the devtools `cache:invalidated` (1.0).

When a `replace` discards the refetch while the entry is still force-stale, `Entry.supersedeByWrite` starts one catch-up fetch, and the entry's `invalidate()` promise follows it. So `invalidateEntry` resolves, or reports to `onError`, with the fetch that reconciled (spec §6.4). See `entry.md`.

The entry catches up the same way when data lands and leaves the stale mark standing. That data is a response requested before a subscriber-less `markStale()`, a page, or a row stamped before it. It does so only while someone holds it, which the entry asks through the `hasSubscribers` option both entry kinds pass (`client.ts:411`, `client.ts:681`). That is how a subscriber, a `resume()` or a `prefetch` that joined the older fetch still gets the refetch §5.7 promises (1.0, second pass).

## Mutation in-flight counter

`mutationsInflight$: Signal<number>` lives on the client, not on each mutation (`client.ts:870`). `MutationImpl` receives it and increments it when a run starts, after `onMutate`, and decrements it in `finally`. A queued `serial` run counts too. `waitForIdle()` waits for this counter and for every entry's `isFetching` (`client.ts:1452-1506`). It re-checks up to 100 times, because a settling fetch can start another, then throws an error listing the entries still fetching. `root.waitForIdle()` wraps it in a second loop that also waits for plugin work (`packages/core/src/controller/root.ts:217-234`).

## SSR

`dehydrate()` walks `maps` and `infiniteMaps` and emits `{ id: query.__id, key: keyArgs, data, lastUpdatedAt }` for each entry that holds data, plus `pageParams` for an infinite entry (`client.ts:1414-1450`). An entry at `status: 'success'` with no data still ships, as before. It skips an entry with no data that is pending, errored or idle. Spec §15. Until the second 1.0 pass it kept only `status: 'success'`, and `status` reads `'pending'` over data during a background refetch and `'error'` after a failed one, so a dehydrate at those moments dropped an entry holding data. `lastUpdatedAt` is the public signal, the time the shipped data was written. Pinned by `ssr.test.ts`, "an entry holding data mid-refetch is serialized".

Two methods take a payload, and both check `version === 1` first (`acceptsState`, `client.ts:1215-1227`):
- `hydrate(state)` is the `RootOptions.hydrate` path, called from the constructor (`client.ts:911`). It only buffers, into `hydratedData: Map<hydrationKey, HydratedSlot>` (`client.ts:1337-1348`).
- `hydrateLive(state, origin?)` backs `root.hydrate` and `host.queries.hydrate` (`client.ts:1331-1334`). `applyDehydratedEntry` writes through to an entry already bound, superseding its fetch, and buffers the rest (`client.ts:1269-1308`). A row stamped before the bound entry's server data is skipped, because `applyHydration` returns `false`, and the client then reports no write. An optimistic write does not count toward that stamp (`entry.md`, "`serverUpdatedAt` is not `lastUpdatedAt`").

Both paths buffer through `bufferRow`, which drops a row stamped before the one already waiting for its key (1.0, second pass). The buffer used to take every row as it came, so an older row replaced a newer one and the first bind showed it. Pinned by `ssr.test.ts`, "a buffered row is not replaced by an older one".

`bindEntry` and `bindInfiniteEntry` check `hydratedData` on the first bind of a key and pass the values into the new entry's `initialData` and `initialUpdatedAt` (`client.ts:1550-1555`, `client.ts:1966-1975`). An infinite entry adopts only a payload whose `pageParams` line up with its pages (`infinitePayload`, `client.ts:223-230`). A buffered slot is consumed once, and later binds refetch as usual. Either path reports one `'hydrate'` write to plugins, carrying the origin of whoever hydrated. See `../flows/ssr.md`.

## Plugins: the engine half of the host

`QueryClient implements PluginEngine` (`client.ts:850`). It holds the root's `PluginSet` in `plugins`, or `null` when the root has no plugins (`client.ts:894`, `client.ts:910`). `PluginSet.install` receives the client as its engine, so a root without an engine never bundles this module. The client supplies four things:

- **Emit sites.** `emitWrite`, `emitInfiniteWrite`, `emitInvalidated`, `emitRemoved` and `emitActivity` (`client.ts:943-1019`). Each returns at once when no plugin listens for its hook. `refOf` caches one `QueryRef` per query (`client.ts:915-926`).
- **Middleware.** `runFetch` (`client.ts:1022-1026`) and `mutationLifecycle(origin?)` (`client.ts:1032-1042`). The second returns `undefined` when no plugin observes mutations, so the runner builds no events.
- **`queryHost(origin)`** (`client.ts:1045-1100`). `get`, `keys` and `peek` read through `byId`. `write` and `replace` go through `writeByKey`, a canonical patch or whole-record write that does nothing when this root holds no entry for the key (`client.ts:1164-1213`). `invalidate`, `hydrate` and `dehydrate` wrap the client's own methods, and `hashKey` is `stableHash`. Every write and invalidation carries `origin`.
- **`mutationHost(origin)`** (`client.ts:1103-1144`). `has` and `get` read the global `defineMutation` registry. `run` keeps one runner per plugin and id, built with `mutationLifecycle(origin)`, so its events carry the plugin's name. It rejects after dispose or for an id nothing registered.

A plugin hook throw never reaches the client: `PluginSet.emit` isolates each hook and reports it with `kind: 'plugin'` and `pluginName`. The write sources, the origin rules and the delivery order are in `../flows/plugin-lifecycle.md`.

`setData` and `setInfiniteData` wrap the returned `Snapshot` so its `rollback()` reports a `'rollback'` write with the restored value (`client.ts:1898-1926`, `client.ts:2161-2178`). The report is guarded on an actual data change. A rollback of a layer below the top replays the layers above it, and a replay that changes nothing keeps the data's reference and reports nothing (1.0, fourth pass). Cross-tab and entity peers then drop the failed optimistic state (T3.6). The wrapped `finalize()` reports `'commit'` through `emitCommit` (`client.ts:1934-1947`) when the entry has no live layer left, and a settle after a commit made under another live layer reports it in place of its `'rollback'` (1.0, fourth pass). The event carries the data on screen, stamped with `serverStamp()`, so a canonical-only plugin such as the cache persister never takes a pending guess and never misses the committed value (§13.1).

## What `close()` and `dispose()` do

`close()` sets `closing`, so a release from here arms no gc timer (`client.ts:2235-2242`). `dispose()` (`client.ts:2248-2276`):
- disposes every `ClientEntry` and `InfiniteClientEntry`, which clears their timers and aborts their fetches;
- clears both maps and `hydratedData`;
- removes the client from every touched query's `__clients`;
- disposes the runners `host.mutations.run` created;
- clears `byId` and the `QueryRef` cache, and sets `disposed`.

The client no longer disposes plugins. `root.dispose()` disposes the `PluginSet` in reverse install order before it disposes the client.

## Malformed hydration payloads (1.0)

`hydrate` and `hydrateLive` apply entries through `eachHydrationEntry`, which skips an entry that fails `isHydrationEntry` or throws, and warns in development (`client.ts:1356-1368`, `client.ts:208-217`). A key nested deep enough to overflow the recursive `stableHash`, or an entry of `null`, used to make `createRoot({ hydrate })` throw. `acceptsState` also requires `entries` to be an array. Pinned by `regressions.test.ts`, "a malformed hydration payload".
