---
name: mutation-queue
description: "@kontsedal/olas-mutation-queue — best-effort persistent replay queue for persist:true mutations (reload + reconnect + cross-tab-coordinated)."
type: module
covers:
  - packages/mutation-queue/src/plugin.ts
  - packages/mutation-queue/src/protocol.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/plugin.test.ts }
  - { type: uses, target: persist.md }
last_verified: 2026-09-20
confidence: high
---

# `@kontsedal/olas-mutation-queue`

A `QueryClientPlugin` that persists `defineMutation({ persist: true })` runs to a `StorageAdapter` (from `@kontsedal/olas-persist`) and replays survivors. Single export `mutationQueuePlugin(options)`; returns `QueryClientPlugin & { replayNow(): Promise<void> }`. Wire format is `protocol.ts` `QueueEntry` (`PROTOCOL_VERSION = 1`), keyed `<keyPrefix>/<mutationId>/<runId>`. Spec §13.3.

## Lifecycle

- `onMutationEnqueue` → `writeEntry` (fire-and-forget; a sync hook can't await — see loss window below).
- `onMutationSettle`: `success` → delete + clear dedupe key; `error` → delete + clear + `onReplayError` ONLY at `attempts >= maxAttempts`, else retain; `cancelled` → retain entry AND dedupe key.
- `init` and `online` event and `replayNow()` → all funnel through `runReplay` (guarded by `replaying`, wrapped in `withReplayLock`) → `replayAll`.

## The three disqualifiers fixed in T6.2

1. **Replay on reconnect, not only reload.** `init` adds a `window` `'online'` listener that calls `runReplay`; `replayNow()` is exposed for manual drive. The `replaying` flag prevents overlap. (Old design replayed only once, at init.)
2. **Cross-tab coordination** (`withReplayLock`, `plugin.ts`). It prefers Web Locks, through `navigator.locks.request(name, { ifAvailable: true }, …)`. A tab that cannot get the lock skips the pass, and the holder replays every entry under the shared prefix. It falls back to a best-effort TTL'd `localStorage` lease, built from `acquireLease`, `releaseLease` and a `setInterval` heartbeat. Node and SSR have neither primitive, so they run uncoordinated. **Best-effort, not exactly-once** — the lease has a residual double-replay window; server `idempotencyKey` is the real gate.
3. **Cache reconciliation** — `onReplaySettle(entry, result, api)` fires after a successful replay; `api.invalidate(query, callArgs)` invalidates in the plugin's owning root so its subscribers refetch server truth. Without it, UIs stay stale until `staleTime` lapses. `callArgs` are the query's own arguments, not the tuple `key()` returns (see `../pitfalls/callargs-vs-keyargs.md`).

## Other T6.2 honesty fixes

- **seq seeded from `Date.now()`** at construction, as `let seqCounter = Date.now()`. A post-restart enqueue that races `init` therefore still sorts after prior-session entries. The old design primed `seq` from disk inside the async `replayAll`, so a racing enqueue got `seq: 1` and jumped the queue. The priming loop inside `replayAll` remains as a same-millisecond cross-tab safety net, and can only raise the value.
- **`activeKeys` cleared only on entry drop**, meaning success and error-after-exhaustion. It is NOT cleared on `cancelled` or on a non-terminal error. Otherwise a re-enqueue after a reload-mid-run cancel would double-write a durable entry for the same logical mutation.
- **Enqueue loss window** documented. The fire-and-forget `writeEntry` can reject on quota, or on an IDB commit abort now that the adapter surfaces those; see `persist.md`, T6.1. The in-process run proceeds and the failure hits `onWarn`, but a crash before commit loses that entry.

## Already-present option surface (was untested → now tested)

`plugin.test.ts` covers the option surface (T6.2). `dedupeBy` collapses on idempotency. `ttlMs` drops expired entries and reports `ttl-expired` through `onReplayError`. `backoffMs` and `maxBackoffMs` give exponential cross-load backoff via `sleep`. `onReplayAttempt` fires on a non-final failure. `migrate` ports an entry from a prior `PROTOCOL_VERSION` in `parseEntry`. `maxEntryBytes` is a soft cap reported through `onWarn`. The `waitForOnline` gate and `seq` ordering are covered too. Direct-call tests on `plugin.onMutationEnqueue(...)` and `onMutationSettle(...)` exercise the dedupe and cancel contract, and a `vi.stubGlobal`'d `navigator` and `window` drive the online gate.

## Limitations

Cross-`mutationId` causal ordering is NOT guaranteed (different ids replay in parallel; cross-tab order isn't coordinated) — model dependent steps under one `mutationId` or make the server order-tolerant. Tracked in `BACKLOG.md`.

## Replay invalidation scope (0.9)

`ReplaySettleApi.invalidate(query, callArgs)` delegates to the owning plugin API, selecting only that root. It uses original fetcher arguments and works for anonymous definitions too. The replay reconciliation test in `packages/mutation-queue/tests/plugin.test.ts` verifies that another live root is not refetched.
