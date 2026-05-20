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
last_verified: 2026-05-20
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

`setData(updater)` records `{ id, prev: previousData, live: true }` and pushes onto `this.snapshots`. Returns `{ rollback, finalize }` (`Snapshot`, see `entry.ts:248-287`). Rollback sets `data` back to that snapshot's captured `prev` and marks the snapshot dead. `finalize` (called by mutation `onSuccess`) drops the snapshot from the live set without reverting — `hasPendingMutations` clears when no live snapshots remain.

The stack is what enables positional rollback: when mutation B's snapshot rolls back, data goes to "state after mutation A's update" because that was the value captured at the moment of B's setData. Spec §6.4.

## firstValue / dispose

`firstValue()` resolves with the next successful data (or rejects on error). If already settled when called, resolves/rejects synchronously via `Promise.resolve` / `Promise.reject`. While pending, the resolver is tracked in `pendingFirstValueRejects: ((err: unknown) => void)[]` so `dispose()` can reject all outstanding `firstValue()` promises with `DOMException('Entry disposed', 'AbortError')` (see `entry.ts:289-316, 328-345`).

`dispose()` aborts current fetch, clears the staleness timer, marks `disposed: true`, and rejects pending `firstValue()` promises. Idempotent.

## Hydrated entries

When `client.bind(...)` finds a query already populated from `dehydrate`/`hydrate`, the entry constructor seeds `status: 'success'` and derives `isStale` from `Date.now() - lastUpdatedAt` (see `entry.ts:88-110`). If the data is fresh enough that the remaining stale window > 0, the constructor also schedules a partial-length `setTimeout` so the entry flips to stale at the correct wall-clock moment — preserving stale-time semantics across the SSR boundary.
