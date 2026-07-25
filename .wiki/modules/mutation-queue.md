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
last_verified: 2026-07-25
confidence: high
---

# `@kontsedal/olas-mutation-queue`

A `QueryClientPlugin` that persists `defineMutation({ persist: true })` runs to a `StorageAdapter` (from `@kontsedal/olas-persist`) and replays survivors. Single export `mutationQueuePlugin(options)`; returns `QueryClientPlugin & { replayNow(): Promise<void> }`. Wire format is `protocol.ts` `QueueEntry` (`PROTOCOL_VERSION = 1`), keyed `<keyPrefix>/<mutationId>/<runId>`. Spec §13.3.

## Lifecycle

- `onMutationEnqueue` → `writeEntry` (fire-and-forget; a sync hook can't await — see loss window below).
- `onMutationSettle`: `success` → delete + clear dedupe key; `error` → delete + clear + `onReplayError` ONLY at `attempts >= maxAttempts`, else retain; `cancelled` → retain entry AND dedupe key.
- `init` / `online` event / `replayNow()` → all funnel through `runReplay` (guarded by `replaying`, wrapped in `withReplayLock`) → `replayAll`.

## The three disqualifiers fixed in T6.2

1. **Replay on reconnect, not only reload.** `init` adds a `window` `'online'` listener that calls `runReplay`; `replayNow()` is exposed for manual drive. The `replaying` flag prevents overlap. (Old design replayed only once, at init.)
2. **Cross-tab coordination** (`withReplayLock`, `plugin.ts`). Prefers Web Locks (`navigator.locks.request(name, { ifAvailable: true }, …)`) — a tab that can't get the lock skips the pass (the holder replays every entry under the shared prefix). Falls back to a best-effort TTL'd `localStorage` lease (`acquireLease`/`releaseLease` + a `setInterval` heartbeat); Node/SSR (neither primitive) runs uncoordinated. **Best-effort, not exactly-once** — the lease has a residual double-replay window; server `idempotencyKey` is the real gate.
3. **Cache reconciliation** — `onReplaySettle(entry, result, api)` fires after a successful replay; `api.invalidate(query, keyArgs)` delegates to the query's own `invalidate(...)` so subscribers refetch server truth. Without it, UIs stay stale until `staleTime` lapses.

## Other T6.2 honesty fixes

- **seq seeded from `Date.now()`** at construction (`let seqCounter = Date.now()`), so a post-restart enqueue that races `init` still sorts after prior-session entries — the old design primed `seq` from disk inside `replayAll` (async), so a racing enqueue got `seq: 1` and jumped the queue. The in-`replayAll` priming loop remains as a same-millisecond-cross-tab safety net (can only raise).
- **`activeKeys` cleared only on entry drop** (success / error-after-exhaustion), NOT on `cancelled` or non-terminal error — else a re-enqueue after a reload-mid-run cancel double-writes a durable entry for the same logical mutation.
- **Enqueue loss window** documented: the fire-and-forget `writeEntry` can reject (quota, or an IDB commit abort now that the adapter surfaces those — see `persist.md`, T6.1); the in-process run proceeds, the failure hits `onWarn`, but a crash before commit loses that entry.

## Already-present option surface (was untested → now tested)

`dedupeBy` (idempotency collapse), `ttlMs` (drop-expired + `ttl-expired` `onReplayError`), `backoffMs`/`maxBackoffMs` (exponential cross-load backoff via `sleep`), `onReplayAttempt` (non-final failure), `migrate` (prior-`PROTOCOL_VERSION` port in `parseEntry`), `maxEntryBytes` (soft cap → `onWarn`), the `waitForOnline` gate, and `seq` ordering — all covered in `plugin.test.ts` (T6.2). Direct-call tests (`plugin.onMutationEnqueue(...)` / `onMutationSettle(...)`) exercise the dedupe/cancel contract; a `vi.stubGlobal`'d `navigator`/`window` drives the online gate.

## Limitations

Cross-`mutationId` causal ordering is NOT guaranteed (different ids replay in parallel; cross-tab order isn't coordinated) — model dependent steps under one `mutationId` or make the server order-tolerant. Tracked in `BACKLOG.md`.
