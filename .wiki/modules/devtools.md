---
name: devtools
description: DebugEvent union (+ seq/t/causeId correlation, cache:set-data, snapshot:*, plugin:event) + per-root DevtoolsEmitter behind root.debug. Free when no one is subscribed.
type: module
covers:
  - packages/core/src/devtools.ts
  - packages/core/src/query/entry.ts:8-36
  - packages/core/src/query/client.ts:150-202
  - packages/core/src/query/client.ts:1077-1098
  - packages/core/src/query/mutation.ts:374-395
  - packages/core/src/controller/root.ts:224-227
  - packages/core/src/controller/instance.ts:386-452
  - packages/core/src/controller/instance.ts:554-575
  - packages/core/src/plugin/host.ts:166-169
  - packages/core/src/query/client.ts:204-222
  - packages/core/src/query/use.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/devtools.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/devtools-events.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/dev-flag.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/devtools-subscribers.test.ts }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: related, target: devtools-panel.md }
  - { type: related, target: ../flows/devtools-causal-timeline.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
last_verified: 2026-09-25
confidence: medium
---

# `devtools.ts`

`DebugEvent` discriminated union (controller lifecycle, cache fetch lifecycle, cache writes, optimistic-snapshot stack, mutation lifecycle, field validation, plugin lanes) + `DevtoolsEmitter` class. Spec §14, §20.9, §21.8.

## The event union shape

`DebugEvent = DebugEventBody & DebugEventMeta`, written as a **distributive conditional** (`devtools.ts:135-139`) — `DebugEventBody extends infer B ? (B extends DebugEventBody ? B & DebugEventMeta : never) : never` — NOT a plain `Body & Meta` intersection. The distribution keeps each variant's literal `type` discriminant intact, so `switch (event.type)` still narrows. A plain intersection with a union does not narrow reliably. `DebugEventMeta` at `devtools.ts:7-27` adds three **optional** fields to every variant: `seq`, `t` and `causeId`. They are optional so hand-built events and the panel store's `handle()` stay valid in tests. The bus stamps `seq` and `t` on delivery regardless, as described below.

## DevtoolsEmitter

One per root, built by `createRootWithProps` (`controller/root.ts:25`). Held inside `RootShared.devtools`, and handed to the `QueryClient` and the `PluginSet`. Emits are routed from `ControllerInstance`, from `QueryClient` (invalidate, gc and set-data), from inside `Entry`, `InfiniteEntry` and `MutationImpl` at the relevant lifecycle points, from the forms, and from `host.debug`.

- `emit(event)` — short-circuits when `handlers.size === 0` (one Set size check), AFTER `recordLifecycle`. So the bus in production with no subscriber costs one Set size check.
- **`seq`/`t` stamping.** `emit` and the subscribe-time replay both route through `stamp(event)` at `devtools.ts:272-276`. It returns a `{ ...event, seq: ++this.seq, t: Date.now() }` COPY and never mutates the caller's inline event. A caller-supplied `causeId` is preserved, and a `causeId: undefined` is dropped, so "no cause" is an absent key. The emitter owns `seq` and `t`, and reassigns them every time. `seq` is per-root monotonic, and a late subscriber's replayed snapshot events get fresh, higher `seq`s, so they still sort before its subsequent live events.
- `subscribe(handler)` — replays the live-controller snapshot (each event `stamp`ed, plus a `controller:suspended` for a suspended controller), then fires on every event; returns unsub. Exposed publicly as `root.debug.subscribe(...)`, next to `root.debug.queryEntries()`, which returns `QueryClient.queryEntriesSnapshot()` (`controller/root.ts:224-227`). `root.debug` is typed `DebugBus` (`devtools.ts:176-179`).
- Handler exceptions are caught — a buggy devtools handler must not break the program.
- Iterates over a snapshot, like `Emitter`.
- **The default build** strips every `emit(...)` call site via tsdown's
  `define: { __DEV__: 'false' }` substitution. Core also ships a development
  build (`dist/dev/`, `__DEV__: 'true'`) behind a `development` export
  condition, which Vite, webpack, Next and Rspack resolve in dev, so the
  devtools see events against the published package (SPEC §23). The bus itself remains:
  `root.debug.subscribe(handler)` still accepts the handler and returns an
  unsubscribe, so consumer code doesn't need a build flag. No events ever
  arrive. The four `controller:*` lifecycle hooks that feed
  `recordLifecycle` are inside the same guard, so the live-controller
  snapshot is empty too. `root.debug.queryEntries()` still works. See the
  production-builds subsection of SPEC §23.

## How events reach the bus

Lifecycle events from `ControllerInstance` go straight through `rootShared.devtools.emit(...)`; see `instance.ts:257-267, 303-305, 376-378, 432-446`. Each call site is wrapped in `if (__DEV__)`, so production builds elide it.

**Cache events** (Phase 13; extended T8.1 and W10). `QueryClient` holds a `devtools?: DevtoolsEmitter`. `devtoolsEntryEvents(devtools, queryId, queryKey)` (`client.ts:150-202`) builds one `EntryEvents` callback bundle, and both `ClientEntry` and `InfiniteClientEntry` pass it to their entry (`client.ts:316`, `client.ts:569`):

- `onFetchStart(fetchId)` in `startFetch()` → `cache:fetch-start`.
- `onFetchSuccess(durationMs, data, fetchId)` in `applySuccess()` → `cache:fetch-success` AND a `cache:set-data` (`source: 'fetch'`) carrying the written data.
- `onFetchError(durationMs, error, fetchId)` in `applyFailure()` → `cache:fetch-error`.
- `onSnapshotPush/Rollback/Finalize()` from `Entry.setData`'s snapshot closures → `snapshot:push/rollback/finalize`.

`fetchId` is a globally-unique per-fetch token from `nextFetchCauseId()` (`entry.ts:31-36`, a module counter shared by `Entry` and `InfiniteEntry`). It is shared across a fetch's start + settle + the set-data it writes, so they group under one `causeId`. The bundle is `undefined` if `devtools` is `undefined`. Fetch events carry the `queryId`.

Every other cache write emits `cache:set-data` through the private `emitDevtoolsSetData` helper (`client.ts:1077-1098`). It uses the plugins' `WriteSource` vocabulary, and each call site passes its source:

- `setData` sends `'optimistic'`, and its snapshot's rollback sends `'rollback'` when the data changed.
- `writeData` sends `'write'` and `replaceData` sends `'replace'`, and so does `writeByKey`, the path behind `host.queries.write` and `replace`.
- `applyDehydratedEntry`, and `bindEntry` adopting a buffered payload, send `'hydrate'`.
- The infinite counterparts send the same sources through `emitInfiniteWrite`, with the pages as `data`.

The ambient cause supplies only the `causeId`. `QueryClient.invalidate`, `invalidateAll` and `dropEntry`, and their infinite counterparts, emit `cache:invalidated` and `cache:gc` directly, with the `queryId`. A plugin's `host.queries.invalidate` emits `cache:invalidated` too (`client.ts:937-949`, 1.0), so a plugin's invalidation shows on the timeline.

**Subscriber events** (1.0). `ClientEntry.acquire(subscriberPath?)` and `release(subscriberPath?)`, and the infinite counterparts, take the subscribing controller's path. `createQuery` reads it from `ctxInternals.path` and hands it to `createUse` and `createInfiniteUse`, which pass it on every acquire and release: bind, key change, disable, suspend, resume and dispose. With a path, the entry emits `cache:subscribed` or `cache:unsubscribed` through `reportSubscriber` (`client.ts`), with `queryId`, `queryKey` and `subscriberPath`, and moves its `subscriptions` count. A prefetch acquires with no path, so it holds the entry for gc and sends nothing. `queryEntriesSnapshot` reports the count as `DebugCacheEntry.subscribers`. Pinned by `devtools-subscribers.test.ts`.

**Mutation events** (Phase 13; `causeId` T8.1). `MutationImpl` takes an optional `DevtoolsEmitter` constructor argument, which `createMutation` in `query/bind.ts:156-166` passes from the controller's internals. Each `executeRun` mints a `runId` up front through `makeRunId()`, generated when a plugin observes mutations or when `__DEV__` is set. That id is BOTH the `runId` on the plugins' `MutationEvent` AND the devtools `causeId`. Each event carries the mutation's `id` as `id` when it has one; an inline spec without one sends none. Before 1.0 the field was named `name`, a leftover from the removed mutation `name`. The private `emit(event, causeId?)` at `mutation.ts:374-395` stamps it onto the `mutation:run`, `success`, `error` and `rollback` events. `mutation:run` fires after `onMutate` succeeds and the counters are bumped. `mutation:success` fires before the user's `onSuccess`, and `mutation:error` before the user's `onError`. `mutation:rollback` fires through a wrapped `Snapshot`. An auto-rollback from supersede, dispose or error emits it, and so does a user-driven `snapshot.rollback()`, exactly once per snapshot.

## `ctx.debug({...})` — controller variables

`ctx.debug(record)`, in `buildCtx` in `instance.ts:554-575`, lets a controller expose named **live** values for the devtools "Variables" view. Signals, computeds and fields are held by reference rather than snapshotted. It is dev-only, guarded by `if (!__DEV__) return`, so it costs nothing and retains nothing in production. It merges across calls into `ControllerInstance.debugValues`. A call while the controller is suspended stores the values and raises `debugPendingEmit`, and `resume()` sends the merged record right after `controller:resumed` (`instance.ts:386-452`).

Timing: `ctx.debug` runs *during* the factory, in state `constructing`, before `construct()` emits `controller:constructed`. The merged record therefore **rides out on `controller:constructed`** as a `debug?` field on that event, correctly ordered and replayed to late subscribers. A call *after* construction, in state `active` and typically from an effect, instead emits a `controller:debug` event carrying the full merged record. A call while **suspended** stores the values and sets `debugPendingEmit`. `resume()` then sends one `controller:debug` with the merged record, right after `controller:resumed` (`instance.ts:432-445`), so the panel never keeps the pre-suspend values. Pinned by `devtools-events.test.ts`, "ctx.debug while suspended is sent on resume". `DevtoolsEmitter.recordLifecycle` stores `debug` per live controller from either event, so replay includes it. The panel renders each value reactively via `useValue()` (see `devtools-panel.md`).

## Correlation backbone (`seq` / `t` / `causeId`)

`seq` + `t` are stamped centrally (see `stamp` above). `causeId` groups all events from one cause into a chain in the devtools timeline:

- **Mutation cause.** `executeRun`'s `runId` is passed to every `mutation:*` emit. The events its `onMutate` and rollback *trigger*, namely the optimistic `cache:set-data` and the `snapshot:*` events, must inherit the same id without threading it through `setData` and `Entry` signatures. Core does that with a **dev-only ambient cause**: `__runWithCause(runId, fn)` and `__currentCauseId()`, appended after the class in `devtools.ts`. `MutationImpl` wraps `onMutate` and the snapshot rollback and finalize in `__runWithCause(runId, ...)`. The QueryClient's set-data and snapshot emit closures read `__currentCauseId()` at emit time. This is synchronous by design, because the correlated writes all happen on the stack while the cause is active. Outside dev builds it is a zero-cost passthrough.
- **Fetch cause.** The `fetchId` minted per `startFetch` is the `causeId` for that fetch's `cache:fetch-*` + `cache:set-data`.
- **Un-attributable writes.** A bare `query.setData(...)` outside any mutation has no ambient cause → `source: 'optimistic'`, no `causeId`. Pinned by `devtools-events.test.ts`, "a bare query.setData is source:optimistic with no causeId".

Every event of a failing optimistic mutation shares one `causeId`, and `devtools-events.test.ts` pins that membership. Read from `mutation.ts:485-597`, the order is:

1. `snapshot:push`, then `cache:set-data` (`optimistic`), both inside `onMutate`;
2. `mutation:run`, after `onMutate` returns;
3. `mutation:error`, before the user's `onError`;
4. `snapshot:rollback`, then `cache:set-data` (`rollback`), then `mutation:rollback`, from the auto-rollback after `onError`.

See [../flows/devtools-causal-timeline.md](../flows/devtools-causal-timeline.md).

**Field validation events** are wired. `createField` calls `bindFieldDevtoolsOwner` (`forms/bind.ts:44-48`), so standalone fields publish `field:validated` with the owning controller path and a synthetic `(field)` name. `createForm` and `createFieldArray` walk their trees via `bindTreeToDevtools`, publishing events with the leaf's dotted path inside the form. See `bindFieldDevtoolsOwner` in `forms/field.ts` and `bindTreeToDevtools` in `forms/form.ts`.

**Plugin events.** A plugin's `host.debug(payload)` emits `plugin:event` with the plugin's name (`plugin/host.ts:166-169`). It is dev-only and silent once the root starts disposing. The panel renders these as lanes, one per plugin (`devtools-panel.md`).

## What's emitted today

| Event family | Status |
|---|---|
| `controller:constructed / suspended / resumed / disposed` | ✓ wired in `ControllerInstance` (`constructed` also carries `debug` — see below) |
| `controller:debug` | ✓ wired via `ctx.debug({...})` (post-construction updates, and on `resume()` after a call made while suspended; construction-time vars ride `controller:constructed`) |
| `cache:fetch-start / fetch-success / fetch-error` | ✓ wired via `EntryEvents` (regular and infinite queries; carry `fetchId` as `causeId`) |
| `cache:set-data` | ✓ wired — every write source: `fetch`, `hydrate`, `optimistic`, `rollback`, `write`, `replace` |
| `cache:invalidated / gc` | ✓ wired in `QueryClient`, `host.queries.invalidate` included |
| `snapshot:push / rollback / finalize` | ✓ wired via `EntryEvents` (regular and infinite queries) |
| `cache:subscribed / unsubscribed` | ✓ wired in `ClientEntry` and `InfiniteClientEntry` `acquire` and `release`, with the subscriber's path |
| `mutation:run / success / error / rollback` | ✓ wired in `MutationImpl` (carry `runId` as `causeId`) |
| `field:validated` | ✓ wired via `bindFieldDevtoolsOwner` / `bindTreeToDevtools` |
| `plugin:event` | ✓ wired via `host.debug` |
| `seq` / `t` on every event | ✓ stamped by `DevtoolsEmitter.emit` + replay |

The discriminated union is non-breaking to extend — consumers `switch` on `type` and ignore unknowns.
