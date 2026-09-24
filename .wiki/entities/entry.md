---
name: entry
description: Per-cache-key state machine — race protection, retry, snapshot stack, staleness timer.
type: entity
covers:
  - packages/core/src/expiry-timer.ts
  - packages/core/src/query/entry.ts
  - packages/core/src/query/infinite.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/expiry-timers.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: uses, target: ../modules/signals.md }
  - { type: related, target: ../pitfalls/isstale-needs-timer.md }
last_verified: 2026-09-24
confidence: high
---

# `Entry<T>`

The per-cache-slot state machine, one `Entry<T>` per unique key. `LocalCache` uses one anonymous entry per controller. `ClientEntry` shares one per `(Query, keyHash)` pair. Spec §5, §21.6.

## Public signals (the AsyncState surface)

`data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`, `isPaused`.

`isPaused` is `true` while a fetch is parked waiting for reconnect. Two paths park. The `online`-mode offline-defer path sets it in `scheduleDeferredFetch` and clears it in `startFetch`'s batch. The `offlineFirst` park path takes a `fetch` `TypeError` raised while `navigator.onLine === false`, resets to a settled status, then calls `scheduleDeferredFetch`. `always` mode never parks. Spec §5.5, T3.5. Pinned by `query-focus-online.test.ts` (R-Q3.5).

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
  if superseded or disposed: throw AbortError     # the newer fetch owns the state; the caller hears the supersede
  if AbortError: apply failure; throw             # the FETCHER aborted itself
  if not shouldRetry(retry, attempt, err): apply failure; throw
  await abortableSleep(computeDelay(retryDelay, attempt), abort.signal)
  attempt++
```

**The two abort cases are not the same, and the order of those checks is the whole distinction** (`entry.ts` `runWithRetry`). Four engine paths abort the controller: `startFetch`, `cancel`, `applyHydration`, `dispose`. Each bumps `currentFetchId` or sets `disposed` first, and each writes the entry's state itself or hands it to the superseding fetch. Such a fetch must write nothing: §5.6, "errors from outdated fetches are also dropped".

An `AbortError` that arrives while this fetch is still `currentFetchId` therefore did **not** come from the engine. It came from the fetcher: its own `AbortSignal.timeout`, an axios cancel token, a rethrown stale abort. Nothing is coming to settle the entry after it, so it settles like any other failure: `status: 'error'`, `error` set, `isFetching` and `isLoading` cleared, `data` untouched.

Rethrowing it, which the single fused check did, left `isFetching` true with nothing to clear it. The spinner then runs until the entry is disposed, `root.waitForIdle()` does not resolve during SSR, and `firstValue()` does not settle under Suspense. The retry policy stays out of it, as it does for every abort. Pinned by `regressions.test.ts` under "a fetcher-originated AbortError settles the entry", which also pins the converse: a superseded fetch aborting late must not clear the newer fetch's `pending`.

**An outdated fetch's caller hears the supersede, not its error (1.0).** The superseded branch rethrew the fetch's own error. The caller then saw a real failure for a request whose result §5.6 says is dropped: `invalidateEntry` routed it to `onError` as a cache error, and `prefetch` rejected with it instead of resolving with the value that won. It now throws `AbortError('Superseded')`, the same as an outdated request that succeeds, and both callers already treat that as a supersede. `InfiniteEntry` does the same in both loops. Pinned by `regressions.test.ts`, "outdated fetches and late releases" and "infinite queries".

**A page request clears `isLoading` when it starts (1.0).** It only starts once pages exist, so the entry is not loading for the first time. A write landing during the first load, followed by `fetchNextPage()`, used to leave `isLoading` true for good: the page request superseded the first load, and neither settled the flag.

`InfiniteEntry` makes the same split in both of its loops (`runRefetchAll` and `runFetch` in `query/infinite.ts`). It has no `applyFailure` to route through, so each loop settles the failure inline: `error` set, `status: 'error'`, `isFetching` and `isLoading` cleared, and for a page fetch the direction flag cleared too. Loaded pages stay. The retry policy is skipped for an abort there as well. Pinned by `regressions.test.ts` under "a fetcher-originated AbortError settles an infinite entry".

`retry`: `number | (attempt, err) => boolean`. `retryDelay`: `number | (attempt) => number`. Defaults: `retry: 0`, `retryDelay: 1000`.

A retried fetch is one logical fetch to the consumer — `isFetching` stays true the whole time, only the final outcome reaches `data`/`error`.

## Staleness

`isStale: Signal<boolean>`, NOT a computed. Why: `Date.now() - lastUpdatedAt > staleTime` would only re-evaluate when `lastUpdatedAt` changes; the passage of time alone wouldn't trigger anything. Instead, we set up a `setTimeout` on each successful fetch that flips `isStale` to true after `staleTime`. `invalidate()` clears the timer and flips immediately. See `../pitfalls/isstale-needs-timer.md`.

`markStale()` forces the entry stale **without fetching**: it clears the timer, sets `isStale`, and sets a private `forcedStale` flag so `isStaleNow()` returns true until the next successful fetch clears it. `invalidate()` = `markStale()` + `startFetch()`. `client.invalidate` calls `markStale()` alone for a subscriber-less entry, so the next subscriber's staleness check refetches instead of waking data no subscriber watches (spec §5.7, T3.9). `InfiniteEntry` mirrors both.

## Snapshot stack (optimistic updates, §6.4)

`setData(updater, opts?)` defaults to the **tracked** (optimistic) path: it records `{ id, prev: previousData, live: true }`, pushes onto `this.snapshots`, flips `hasPendingMutations`, and returns a working `{ rollback, finalize }` (`Snapshot`). `finalize`, called by mutation `onSuccess`, drops the snapshot from the live set without reverting. `hasPendingMutations` clears once no live snapshots remain.

**Rollback is chain-spliced, not a blind restore** (`entry.ts:415-437`, spec §6.4). It marks the snapshot dead, then branches on its position in the live stack:

- **Top of the stack** (most-recent live snapshot): restore `data` to the snapshot's captured `prev`, then drop it. This is the LIFO case — the only one previously tested.
- **Not the top**: leave `data` untouched, because a middle layer cannot be removed cleanly without replaying the updaters above it. Thread this layer's `prev` down onto the next layer with `snapshots[i+1].prev = record.prev`, then drop it.

The invariant this guarantees: **rolling back every live snapshot — in any order — returns `data` to the original pre-mutation value.** The prior code restored `record.prev` unconditionally. An out-of-order rollback then resurrected A's delta and left the wrong final value: A and B both apply, A fails first, then B fails. Pinned by `regressions.test.ts` under R-Q3.1. `InfiniteEntry.setData` mirrors the same chain-splice, threading both `prev` (pages) and `prevParams`.

**Fetch success rebases live snapshots** (`entry.ts` `applySuccess`, spec §6.4, T3.4). Before writing the fresh value, `applySuccess` sets `record.prev = shared` for every live snapshot. So if a fetch lands while an optimistic mutation is pending, a later rollback restores *server truth* rather than the pre-fetch baseline the snapshot captured. Without that, a refetch mid-mutation followed by a mutation failure would resurrect stale pre-fetch data. Pinned by R-Q3.4.

`setData(updater, { track: false })` is a **canonical cache write**. Its callers are cross-tab receive through `client.applyRemoteSetData`, and entity backprop and realtime patches through `client.setEntryData`. It writes `data` but pushes NO snapshot and does NOT flip `hasPendingMutations`, returning a no-op `Snapshot`. This is why a fire-and-forget plugin write can no longer wedge `hasPendingMutations` at `true`. The T1.1 bug was exactly that those callers went through the tracked path and discarded the returned snapshot. `InfiniteEntry.setData` mirrors the same `track` option. Pinned by `regressions.test.ts` (R-Q1.1).

The stack is what enables positional rollback: when top-of-stack mutation B rolls back, data goes to "state after mutation A's update" because that was the value B captured at its setData. Non-top rollbacks chain-splice instead (above). Spec §6.4.

## cancel

`cancel()` aborts an in-flight fetch on demand without touching `data`. It bumps `currentFetchId`, so the running `runWithRetry` loses its supersede check and never writes, aborts `currentAbort`, and restores a settled status: `'success'` if data exists, else `'idle'`. It is a no-op when nothing is fetching. It is the primitive behind the public `query.cancel(...)` and `subscription.cancel()`, wired in `define.ts` through `client.cancel` and `cancelAll` to `entry.cancel`. It is also the primitive behind the canonical optimistic recipe: cancel outgoing refetches before an optimistic `setData` so a stale response cannot clobber it (spec §5.5, §6.4). `InfiniteEntry.cancel` mirrors it, and also clears the per-direction paging flags. Pinned by R-Q3.4.

## firstValue / dispose

`firstValue()` resolves with the next successful data (or rejects on error). If already settled when called, resolves/rejects synchronously via `Promise.resolve` and `Promise.reject`. While pending, the resolver is tracked in `pendingFirstValueRejects: ((err: unknown) => void)[]` so `dispose()` can reject all outstanding `firstValue()` promises with `DOMException('Entry disposed', 'AbortError')` (see `entry.ts:289-316, 328-345`).

`dispose()` aborts current fetch, clears the staleness timer, marks `disposed: true`, and rejects pending `firstValue()` promises. Idempotent.

## Hydrated entries

When `client.bind(...)` finds a query already populated from `dehydrate`/`hydrate`, the entry constructor seeds `status: 'success'` and derives `isStale` from `Date.now() - lastUpdatedAt` (see `entry.ts:88-110`). If the data is fresh enough that the remaining stale window is above zero, the constructor also schedules a partial-length timer. The entry then flips to stale at the correct wall-clock moment, preserving stale-time semantics across the SSR boundary.

## Expiry scheduling (0.9)

`scheduleExpiry` in `expiry-timer.ts` returns a cancellation closure, or `null` for a non-finite delay. `null` is the "nothing scheduled" state the callers already check for, so `Infinity` means *no timer* rather than a clamped one. Finite delays beyond 2,147,483,647 ms are walked in chunks against an absolute deadline. Fetch success, initial hydration and streaming hydration share this scheduler; infinite queries use it too. Disposal invokes the closure, clearing the current chunk. Explicit invalidation still marks an `Infinity` entry stale.

The same scheduler backs the **gc** timer in `ClientEntry` and `InfiniteClientEntry`, at `client.ts:256`, `:352`, `:468` and `:530`. That is why `gcTime: Infinity` retains a released entry for the life of the root. Both timers had the same defect before 0.9. A bare `setTimeout` clamps an out-of-range delay to about 1ms, so the two settings that mean "keep this the longest" behaved as the shortest. See `pitfalls/isstale-needs-timer.md`. Covered by `packages/core/tests/expiry-timers.test.ts`.
