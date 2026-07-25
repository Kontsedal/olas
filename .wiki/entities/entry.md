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
last_verified: 2026-07-25
confidence: high
---

# `Entry<T>`

The per-cache-slot state machine. One `Entry<T>` per unique key. Used by `LocalCache` (anonymous, one per controller) and by `ClientEntry` (shared, one per `(Query, keyHash)`). Spec §5, §21.6.

## Public signals (the AsyncState surface)

`data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`, `isPaused`.

`isPaused` is `true` while a fetch is parked waiting for reconnect — the `online`-mode offline-defer path (`scheduleDeferredFetch` sets it; `startFetch`'s batch clears it) and the `offlineFirst` park path (a `fetch`-`TypeError` while `navigator.onLine === false` → reset to a settled status, then `scheduleDeferredFetch`). `always` mode never parks. Spec §5.5, T3.5. Pinned by `query-focus-online.test.ts` (R-Q3.5).

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

`setData(updater, opts?)` defaults to the **tracked** (optimistic) path: it records `{ id, prev: previousData, live: true }`, pushes onto `this.snapshots`, flips `hasPendingMutations`, and returns a working `{ rollback, finalize }` (`Snapshot`). `finalize` (called by mutation `onSuccess`) drops the snapshot from the live set without reverting — `hasPendingMutations` clears when no live snapshots remain.

**Rollback is chain-spliced, not a blind restore** (`entry.ts:415-437`, spec §6.4). It marks the snapshot dead, then branches on its position in the live stack:

- **Top of the stack** (most-recent live snapshot): restore `data` to the snapshot's captured `prev`, then drop it. This is the LIFO case — the only one previously tested.
- **Not the top**: leave `data` untouched (a middle layer can't be removed cleanly without replaying the updaters above it) and thread this layer's `prev` down onto the next layer (`snapshots[i+1].prev = record.prev`), then drop it.

The invariant this guarantees: **rolling back every live snapshot — in any order — returns `data` to the original pre-mutation value.** The prior code restored `record.prev` unconditionally, so an out-of-order rollback (A then B applied, A fails first, then B fails) resurrected A's delta and left the wrong final value. Pinned by `regressions.test.ts` (R-Q3.1). `InfiniteEntry.setData` mirrors the same chain-splice, threading both `prev` (pages) and `prevParams`.

**Fetch success rebases live snapshots** (`entry.ts` `applySuccess`, spec §6.4, T3.4). Before writing the fresh value, `applySuccess` sets `record.prev = shared` for every live snapshot. So if a fetch lands while an optimistic mutation is pending, a later rollback restores *server truth*, not the pre-fetch baseline the snapshot captured — otherwise a refetch mid-mutation then a mutation failure would resurrect stale pre-fetch data. Pinned by R-Q3.4.

`setData(updater, { track: false })` is a **canonical cache write** — cross-tab receive (`client.applyRemoteSetData`), entity backprop / realtime patches (`client.setEntryData`). It writes `data` but pushes NO snapshot and does NOT flip `hasPendingMutations`, returning a no-op `Snapshot`. This is why a fire-and-forget plugin write can no longer wedge `hasPendingMutations` at `true` — the T1.1 bug was exactly that those callers went through the tracked path and discarded the returned snapshot. `InfiniteEntry.setData` mirrors the same `track` option. Pinned by `regressions.test.ts` (R-Q1.1).

The stack is what enables positional rollback: when top-of-stack mutation B rolls back, data goes to "state after mutation A's update" because that was the value B captured at its setData. Non-top rollbacks chain-splice instead (above). Spec §6.4.

## cancel

`cancel()` aborts an in-flight fetch on demand without touching `data`: it bumps `currentFetchId` (so the running `runWithRetry` loses its supersede check and never writes), aborts `currentAbort`, and restores a settled status — `'success'` if data exists, else `'idle'`. No-op when nothing is fetching. It is the primitive behind the public `query.cancel(...)` / `subscription.cancel()` (wired in `define.ts` → `client.cancel`/`cancelAll` → `entry.cancel`) and the canonical optimistic recipe: cancel outgoing refetches before an optimistic `setData` so a stale response can't clobber it (spec §5.5, §6.4). `InfiniteEntry.cancel` mirrors it (also clears the per-direction paging flags). Pinned by R-Q3.4.

## firstValue / dispose

`firstValue()` resolves with the next successful data (or rejects on error). If already settled when called, resolves/rejects synchronously via `Promise.resolve` / `Promise.reject`. While pending, the resolver is tracked in `pendingFirstValueRejects: ((err: unknown) => void)[]` so `dispose()` can reject all outstanding `firstValue()` promises with `DOMException('Entry disposed', 'AbortError')` (see `entry.ts:289-316, 328-345`).

`dispose()` aborts current fetch, clears the staleness timer, marks `disposed: true`, and rejects pending `firstValue()` promises. Idempotent.

## Hydrated entries

When `client.bind(...)` finds a query already populated from `dehydrate`/`hydrate`, the entry constructor seeds `status: 'success'` and derives `isStale` from `Date.now() - lastUpdatedAt` (see `entry.ts:88-110`). If the data is fresh enough that the remaining stale window > 0, the constructor also schedules a partial-length `setTimeout` so the entry flips to stale at the correct wall-clock moment — preserving stale-time semantics across the SSR boundary.
