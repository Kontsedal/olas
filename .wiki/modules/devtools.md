---
name: devtools
description: DebugEvent union (+ seq/t/causeId correlation, cache:set-data, snapshot:*) + per-root DevtoolsEmitter. Free when no one is subscribed.
type: module
covers:
  - packages/core/src/devtools.ts
  - packages/core/src/query/entry.ts:7-38
  - packages/core/src/query/client.ts:98-140
  - packages/core/src/query/mutation.ts:230-246
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/devtools.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/devtools-events.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/dev-flag.test.ts }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: related, target: devtools-panel.md }
  - { type: related, target: ../flows/devtools-causal-timeline.md }
last_verified: 2026-07-28
confidence: medium
---

# `devtools.ts`

`DebugEvent` discriminated union (controller lifecycle, cache fetch lifecycle, cache writes, optimistic-snapshot stack, mutation lifecycle, field validation) + `DevtoolsEmitter` class. Spec §14, §20.9, §21.8.

## The event union shape

`DebugEvent = DebugEventBody & DebugEventMeta`, written as a **distributive conditional** (`devtools.ts:92-96`) — `DebugEventBody extends infer B ? (B extends DebugEventBody ? B & DebugEventMeta : never) : never` — NOT a plain `Body & Meta` intersection. The distribution keeps each variant's literal `type` discriminant intact, so `switch (event.type)` still narrows. A plain intersection with a union does not narrow reliably. `DebugEventMeta` at `devtools.ts:7-27` adds three **optional** fields to every variant: `seq`, `t` and `causeId`. They are optional so hand-built events and the panel store's `handle()` stay valid in tests. The bus stamps `seq` and `t` on delivery regardless, as described below.

## DevtoolsEmitter

One per root. Held inside `RootShared.devtools`. Emits are routed from `ControllerInstance`, from `QueryClient` (invalidate, gc and set-data), and from inside `Entry` and `MutationImpl` at the relevant lifecycle points.

- `emit(event)` — short-circuits when `handlers.size === 0` (one Set size check), AFTER `recordLifecycle`. So the bus in production with no subscriber costs one Set size check.
- **`seq`/`t` stamping.** `emit` and the subscribe-time replay both route through `stamp(event)` at `devtools.ts:203-211`. It returns a `{ ...event, seq: ++this.seq, t: Date.now() }` COPY and never mutates the caller's inline event. A caller-supplied `causeId` is preserved. The emitter owns `seq` and `t`, and reassigns them every time. `seq` is per-root monotonic, and a late subscriber's replayed snapshot events get fresh, higher `seq`s, so they still sort before its subsequent live events.
- `subscribe(handler)` — replays the live-controller snapshot (each event `stamp`ed), then fires on every event; returns unsub. Exposed publicly via `root.__debug.subscribe(...)`.
- Handler exceptions are caught — a buggy devtools handler must not break the program.
- Iterates over a snapshot, like `Emitter`.
- **Production builds** strip every `emit(...)` call site via tsdown's
  `define: { __DEV__: 'false' }` substitution. The bus itself remains
  exported — `subscribe(handler)` still works and returns a no-op unsub so
  consumer code doesn't need a build flag — but no events ever arrive. The
  four `controller:*` lifecycle hooks that feed `recordLifecycle` are
  inside the same guard, so the live-controller snapshot is empty too.
  See SPEC §23 *Devtools and `__debug` and production builds*.

## How events reach the bus

Lifecycle events from `ControllerInstance` go straight through `rootShared.devtools.emit(...)`; see `instance.ts:101-107, 145-147, 213-215, 250-252`. Each call site is wrapped in `if (__DEV__)`, so production builds elide it. See SPEC §23 *Devtools and `__debug` and production builds*.

**Cache events** (Phase 13; extended T8.1). `QueryClient` holds a `devtools?: DevtoolsEmitter`. `ClientEntry`'s constructor builds an `EntryEvents` callback bundle (`client.ts:98-140`) and passes it to `Entry`:

- `onFetchStart(fetchId)` in `startFetch()` → `cache:fetch-start`.
- `onFetchSuccess(durationMs, data, fetchId)` in `applySuccess()` → `cache:fetch-success` AND a `cache:set-data` (`source: 'fetch'`) carrying the written data.
- `onFetchError(durationMs, error, fetchId)` in `applyFailure()` → `cache:fetch-error`.
- `onSnapshotPush/Rollback/Finalize()` from `Entry.setData`'s snapshot closures → `snapshot:push/rollback/finalize`.

`fetchId` is a globally-unique per-fetch token (`entry.ts` module counter `globalFetchSeq`) shared across a fetch's start + settle + the set-data it writes, so they group under one `causeId`. The bundle is `undefined` if `devtools` is `undefined`. `QueryClient.setData`, `setInfiniteData`, `applyRemoteSetData`, `applyDehydratedEntry` and `setEntryData` also emit `cache:set-data` via the private `emitDevtoolsSetData` helper (`source` derived from the ambient cause — see below — or passed explicitly for `'remote'`). `QueryClient.invalidate`, `invalidateAll` and `dropEntry` emit `cache:invalidated` and `cache:gc` directly.

**Mutation events** (Phase 13; `causeId` T8.1). `MutationImpl` takes an optional `DevtoolsEmitter` constructor argument from `ctx.mutation` (via `instance.ts`). Each `executeRun` mints a `runId` up front through `makeRunId()`, generated when the run is persistable or when `__DEV__` is set. That id is BOTH the persistable run id AND the devtools `causeId`. The private `emit(event, causeId?)` at `mutation.ts:230-246` stamps it onto the `mutation:run`, `success`, `error` and `rollback` events. `mutation:run` fires after `onMutate` succeeds and the counters are bumped. `mutation:success` fires before the user's `onSuccess`, and `mutation:error` before the user's `onError`. `mutation:rollback` fires through a wrapped `Snapshot`. An auto-rollback from supersede, dispose or error emits it, and so does a user-driven `snapshot.rollback()`, exactly once per snapshot.

## `ctx.debug({...})` — controller variables

`ctx.debug(record)`, in `buildCtx` in `instance.ts`, lets a controller expose named **live** values for the devtools "Variables" view. Signals, computeds and fields are held by reference rather than snapshotted. It is dev-only, guarded by `if (!__DEV__) return`, so it costs nothing and retains nothing in production. It merges across calls into `ControllerInstance.debugValues`.

Timing: `ctx.debug` runs *during* the factory, in state `constructing`, before `construct()` emits `controller:constructed`. The merged record therefore **rides out on `controller:constructed`** as a `debug?` field on that event, correctly ordered and replayed to late subscribers. A call *after* construction, in state `active` and typically from an effect, instead emits a `controller:debug` event carrying the full merged record. `DevtoolsEmitter.recordLifecycle` stores `debug` per live controller from either event, so replay includes it. The panel renders each value reactively via `use()` (see `devtools-panel.md`).

## Correlation backbone (`seq` / `t` / `causeId`)

`seq` + `t` are stamped centrally (see `stamp` above). `causeId` groups all events from one cause into a chain in the devtools timeline:

- **Mutation cause.** `executeRun`'s `runId` is passed to every `mutation:*` emit. The events its `onMutate` and rollback *trigger*, namely the optimistic `cache:set-data` and the `snapshot:*` events, must inherit the same id without threading it through `setData` and `Entry` signatures. Core does that with a **dev-only ambient cause**: `__runWithCause(runId, fn)` and `__currentCauseId()`, appended after the class in `devtools.ts`. `MutationImpl` wraps `onMutate` and the snapshot rollback and finalize in `__runWithCause(runId, ...)`. The QueryClient's set-data and snapshot emit closures read `__currentCauseId()` at emit time. This is synchronous by design, because the correlated writes all happen on the stack while the cause is active. Outside dev builds it is a zero-cost passthrough.
- **Fetch cause.** The `fetchId` minted per `startFetch` is the `causeId` for that fetch's `cache:fetch-*` + `cache:set-data`.
- **Un-attributable writes.** A bare `query.setData(...)` outside any mutation has no ambient cause → `source: 'set'`, no `causeId`.

The whole chain for a failing optimistic mutation — `mutation:run` → `snapshot:push` → `cache:set-data(mutate)` → `snapshot:rollback` → `cache:set-data(mutate)` → `mutation:rollback` → `mutation:error` — shares one `causeId`. See [../flows/devtools-causal-timeline.md](../flows/devtools-causal-timeline.md).

**Field validation events** are wired. `ctx.field` calls `bindFieldDevtoolsOwner`, so standalone fields publish `field:validated` with the owning controller path and a synthetic `(field)` name. `ctx.form` and `ctx.fieldArray` walk their trees via `bindTreeToDevtools`, publishing events with the leaf's dotted path inside the form. See `bindFieldDevtoolsOwner` in `forms/field.ts` and `bindTreeToDevtools` in `forms/form.ts`.

## What's emitted today

| Event family | Status |
|---|---|
| `controller:constructed / suspended / resumed / disposed` | ✓ wired in `ControllerInstance` (`constructed` also carries `debug` — see below) |
| `controller:debug` | ✓ wired via `ctx.debug({...})` (post-construction updates; construction-time vars ride `controller:constructed`) |
| `cache:fetch-start / fetch-success / fetch-error` | ✓ wired via `EntryEvents` (regular queries; carry `fetchId` as `causeId`) |
| `cache:set-data` | ✓ wired — fetch success + `setData` / `setInfiniteData` / remote / dehydrate / `setEntryData` |
| `cache:invalidated / gc` | ✓ wired in `QueryClient` |
| `snapshot:push / rollback / finalize` | ✓ wired via `EntryEvents` (regular queries) |
| `cache:subscribed` | declared, NOT wired (needs subscriber-path threading through `use → acquire` — see BACKLOG) |
| `mutation:run / success / error / rollback` | ✓ wired in `MutationImpl` (carry `runId` as `causeId`) |
| `field:validated` | ✓ wired via `bindFieldDevtoolsOwner` / `bindTreeToDevtools` |
| `seq` / `t` on every event | ✓ stamped by `DevtoolsEmitter.emit` + replay |

Infinite queries do NOT yet emit `cache:fetch-*` or `snapshot:*` devtools events (`InfiniteEntry` has no `EntryEvents` hooks); `setInfiniteData` DOES emit `cache:set-data`. See BACKLOG.

The discriminated union is non-breaking to extend — consumers `switch` on `type` and ignore unknowns.
