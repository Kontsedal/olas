---
name: entry
description: Per-cache-key state machine — race protection, retry, snapshot stack, staleness timer.
type: entity
covers:
  - packages/core/src/query/entry.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../modules/signals.md }
  - { type: related, target: ../pitfalls/isstale-needs-timer.md }
last_verified: 2026-05-18
confidence: high
---

# `Entry<T>`

The per-cache-slot state machine. One `Entry<T>` per unique key. Used by `LocalCache` (anonymous, one per controller) and by `ClientEntry` (shared, one per `(Query, keyHash)`). Spec §5, §21.6.

## Public signals (the AsyncState surface)

`data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`.

## Race protection

`currentFetchId: number` (monotonic) + `currentAbort: AbortController | null`. Each `startFetch()`:

1. Increments `currentFetchId`.
2. Aborts the previous `currentAbort` (cancelling any in-flight fetcher).
3. Allocates a new `AbortController`.
4. Runs `runWithRetry(myId, abort)`.

In `runWithRetry`, every iteration of the retry loop checks `myId !== this.currentFetchId || this.disposed` and bails with `AbortError`. The fetcher's awaited promise is checked **after** resolving too — race results from a stale fetch never write to the Entry.

## Retry loop

```
attempt = 0
loop:
  result = await fetcher(abort.signal)
  if superseded: throw AbortError
  apply success; return
catch err:
  if signal.aborted or AbortError: throw          # supersede path
  if not shouldRetry(retry, attempt, err): apply failure; throw
  await abortableSleep(computeDelay(retryDelay, attempt), abort.signal)
  attempt++
```

`retry`: `number | (attempt, err) => boolean`. `retryDelay`: `number | (attempt) => number`. Defaults: `retry: 0`, `retryDelay: 1000`.

A retried fetch is one logical fetch to the consumer — `isFetching` stays true the whole time, only the final outcome reaches `data`/`error`.

## Staleness

`isStale: Signal<boolean>`, NOT a computed. Why: `Date.now() - lastUpdatedAt > staleTime` would only re-evaluate when `lastUpdatedAt` changes; the passage of time alone wouldn't trigger anything. Instead, we set up a `setTimeout` on each successful fetch that flips `isStale` to true after `staleTime`. `invalidate()` clears the timer and flips immediately. See `../pitfalls/isstale-needs-timer.md`.

## Snapshot stack (optimistic updates, §6.4)

`setData(updater)` records `{ id, prev: previousData, live: true }` and pushes onto `this.snapshots`. Returns `{ rollback }`. Rollback sets `data` back to that snapshot's captured `prev` and marks the snapshot dead.

The stack is what enables positional rollback: when mutation B's snapshot rolls back, data goes to "state after mutation A's update" because that was the value captured at the moment of B's setData. Spec §6.4.

`finalizeSnapshot(snapshot)` (used by mutation `onSuccess` — not wired in current code) drops the snapshot from the live set without reverting; clears `hasPendingMutations` when no live snapshots remain.

## firstValue / dispose

`firstValue()` resolves with the next successful data (or rejects on error). If already settled when called, resolves/rejects synchronously via `Promise.resolve` / `Promise.reject`.

`dispose()` aborts current fetch, clears the staleness timer, marks `disposed: true`. Idempotent.
