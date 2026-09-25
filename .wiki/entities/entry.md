---
name: entry
description: Per-cache-key state machine — race protection, retry, snapshot stack, staleness timer.
type: entity
covers:
  - packages/core/src/expiry-timer.ts
  - packages/core/src/query/entry.ts
  - packages/core/src/query/infinite.ts
  - packages/core/src/query/client.ts:1024-1061
  - packages/core/src/query/client.ts:1594-1667
edges:
  - { type: tested-by, target: ../../packages/core/tests/expiry-timers.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/catch-up-refetch.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/retry-policy-throws.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-rebase.test.ts }
  - { type: uses, target: ../modules/signals.md }
  - { type: related, target: ../pitfalls/isstale-needs-timer.md }
  - { type: related, target: ../decisions/canonical-vs-optimistic-writes.md }
last_verified: 2026-09-25
confidence: high
---

# `Entry<T>`

The per-cache-slot state machine, one `Entry<T>` per unique key. `LocalCache` uses one anonymous entry per controller. `ClientEntry` shares one per `(Query, keyHash)` pair. Spec §5, §21.6.

## Public signals (the AsyncState surface)

`data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`, `isPaused` (`entry.ts:129-139`). `AsyncState.isEnabled` belongs to the subscription in `use.ts`, because an entry has no `enabled` switch.

`isPaused` is `true` while a fetch is parked waiting for reconnect. Two paths park. The `online`-mode offline-defer path sets it in `scheduleDeferredFetch` and clears it in `startFetch`'s batch. The `offlineFirst` park path takes a `fetch` `TypeError` raised while `navigator.onLine === false`, resets to a settled status, then calls `scheduleDeferredFetch`. `always` mode never parks. Spec §5.5, T3.5. Pinned by `query-focus-online.test.ts` (R-Q3.5).

## Race protection

`currentFetchId: number` (monotonic) + `currentAbort: AbortController | null`. Each `startFetch()` (`entry.ts:237-272`):

1. Increments `currentFetchId`.
2. Aborts the previous `currentAbort` (cancelling any in-flight fetcher).
3. Allocates a new `AbortController`.
4. Runs `runWithRetry(myId, abort)` inside `releaseOnSettle`.

In `runWithRetry`, every iteration of the retry loop checks `myId !== this.currentFetchId || this.disposed` and bails with `AbortError`. The fetcher's awaited promise is checked **after** resolving too — race results from a stale fetch never write to the Entry.

## Retry loop

```
attempt = 0
loop:
  result = await fetcher(abort.signal, attempt)   # the attempt number reaches wrapFetch
  if superseded: throw AbortError
  apply success; return
catch err:
  if superseded or disposed: throw AbortError     # the newer fetch owns the state; the caller hears the supersede
  if AbortError: apply failure; throw             # the FETCHER aborted itself
  try: delay = shouldRetry(attempt, err) ? computeDelay(attempt) : null
  catch policyErr: apply failure(policyErr, cause: err); throw   # a throwing retry callback
  if delay is null: apply failure; throw
  await abortableSleep(delay, abort.signal)
  attempt++
```

**The two abort cases are not the same, and the order of those checks is the whole distinction** (`entry.ts:332-395`, `runWithRetry`). Four engine paths abort the controller: `startFetch`, `cancel`, `applyHydration`, `dispose`. Each bumps `currentFetchId` or sets `disposed` first, and each writes the entry's state itself or hands it to the superseding fetch. Such a fetch must write nothing: §5.6, "errors from outdated fetches are also dropped".

An `AbortError` that arrives while this fetch is still `currentFetchId` therefore did **not** come from the engine. It came from the fetcher: its own `AbortSignal.timeout`, an axios cancel token, a rethrown stale abort. Nothing is coming to settle the entry after it, so it settles like any other failure: `status: 'error'`, `error` set, `isFetching` and `isLoading` cleared, `data` untouched.

Rethrowing it, which the single fused check did, left `isFetching` true with nothing to clear it. The spinner then runs until the entry is disposed, `root.waitForIdle()` does not resolve during SSR, and `firstValue()` does not settle under Suspense. The retry policy stays out of it, as it does for every abort. Pinned by `regressions.test.ts` under "a fetcher-originated AbortError settles the entry", which also pins the converse: a superseded fetch aborting late must not clear the newer fetch's `pending`.

**An outdated fetch's caller hears the supersede, not its error (1.0).** The superseded branch rethrew the fetch's own error. The caller then saw a real failure for a request whose result §5.6 says is dropped: `invalidateEntry` routed it to `onError` as a cache error, and `prefetch` rejected with it instead of resolving with the value that won. It now throws `AbortError('Superseded')`, the same as an outdated request that succeeds, and both callers already treat that as a supersede. `InfiniteEntry` does the same in both loops. Pinned by `regressions.test.ts`, "outdated fetches and late releases" and "infinite queries".

**A settled request lets go of its `AbortController` (1.0).** `releaseOnSettle` clears `currentAbort` when the request that owns it settles, in both entry classes. Before, the next fetch, a hydration, a cancel or dispose aborted a finished request's controller. That cancelled nothing, fired late `abort` listeners on the fetcher's `signal`, and cost a `DOMException` per call, which was half of a 1,000-query root's CPU time (`decisions/benchmarks.md`).

**A page request clears `isLoading` when it starts (1.0).** It only starts once pages exist, so the entry is not loading for the first time. A write landing during the first load, followed by `fetchNextPage()`, used to leave `isLoading` true for good: the page request superseded the first load, and neither settled the flag.

`InfiniteEntry` makes the same split in both of its loops (`runRefetchAll` and `runFetch` in `query/infinite.ts`). Each loop settles a failure through `settleFailure` (`infinite.ts:917`): `error` set, `status: 'error'`, `isFetching` and `isLoading` cleared, and for a page fetch the direction flag cleared too. Loaded pages stay. The retry policy is skipped for an abort there as well. Pinned by `regressions.test.ts` under "a fetcher-originated AbortError settles an infinite entry".

`retry`: `number | (attempt, err) => boolean`. `retryDelay`: `number | (attempt) => number`. The default is `retry: 0`. With retries on and no `retryDelay`, the delay is exponential, `min(1000 * 2 ** attempt, 30_000)` ms (`entry.ts:404-411`, T3.9).

A retried fetch is one logical fetch to the consumer — `isFetching` stays true the whole time, only the final outcome reaches `data`/`error`.

**A throwing `retry` or `retryDelay` callback fails the attempt (1.0).** Both callbacks run inside the loop's `catch`. A throw there used to escape the loop: the fetch promise rejected, and `isFetching` stayed true with nothing to clear it, the same wedge as the fetcher-originated abort. Now the throw is that attempt's failure, settled through `applyFailure` with the thrown error (`entry.ts:332`). `InfiniteEntry` does the same in both loops, through `nextRetryDelay` and `settleFailure` (`infinite.ts:905-934`). The mutation runner never wedged: its `runWithRetry` rejects, and the run's own `catch` settles it. Pinned by `retry-policy-throws.test.ts`, the mutation case included.

**Each failure is recorded for `ErrorContext`.** `applyFailure` stores `{ error, attempt, cause? }` as `lastFailure`, with `cause` present only when a policy callback threw. `failureOf(err)` (`entry.ts:569`) returns `attempt` and `cause` when `err` is that failure, and `client.invalidateEntry` spreads them into the `kind: 'cache'` context. `InfiniteEntry.failureOf` mirrors it. See `../modules/errors.md`.

## Staleness

`isStale: Signal<boolean>`, NOT a computed. Why: `Date.now() - lastUpdatedAt > staleTime` would only re-evaluate when `lastUpdatedAt` changes; the passage of time alone wouldn't trigger anything. Instead, we set up a `setTimeout` on each successful fetch that flips `isStale` to true after `staleTime`. `invalidate()` clears the timer and flips immediately. See `../pitfalls/isstale-needs-timer.md`.

`markStale()` forces the entry stale **without fetching**: it clears the timer, sets `isStale`, and sets a private `forcedStale` flag so `isStaleNow()` returns true until the next successful fetch clears it. `invalidate()` = `markStale()` + `startFetch()` (`entry.ts:548-571`). `client.invalidateEntry` calls `markStale()` alone for a subscriber-less entry (`client.ts:1459-1495`), so the next subscriber's staleness check refetches instead of waking data no subscriber watches (spec §5.7, T3.9). `InfiniteEntry` mirrors both.

## Snapshot stack (optimistic updates, §6.4)

`setData(updater, opts?)` (`entry.ts:653-739`) defaults to the **tracked** (optimistic) path: it records `{ id, prev: previousData, live: true }`, pushes onto `this.snapshots`, flips `hasPendingMutations`, and returns a working `{ rollback, finalize }` (`Snapshot`). The mutation runner calls `finalize` after a successful run's `onSuccess`, which drops the snapshot from the live set without reverting. `hasPendingMutations` clears once no live snapshots remain. Either path flips an `idle` or `pending` entry to `success`.

**Rollback is chain-spliced, not a blind restore** (`entry.ts:695-724`, spec §6.4). It marks the snapshot dead, then branches on its position in the live stack:

- **Top of the stack** (most-recent live snapshot): restore `data` to the snapshot's captured `prev`, then drop it. This is the LIFO case — the only one previously tested.
- **Not the top**: leave `data` untouched, because a middle layer cannot be removed cleanly without replaying the updaters above it. Thread this layer's `prev` down onto the next layer with `snapshots[i+1].prev = record.prev`, then drop it.

The invariant this guarantees: **rolling back every live snapshot — in any order — returns `data` to the original pre-mutation value.** The prior code restored `record.prev` unconditionally. An out-of-order rollback then resurrected A's delta and left the wrong final value: A and B both apply, A fails first, then B fails. Pinned by `regressions.test.ts` under R-Q3.1. `InfiniteEntry.setData` mirrors the same chain-splice, threading both `prev` (pages) and `prevParams`.

**Fetch success rebases live snapshots** (`entry.ts:428-430` in `applySuccess`, spec §6.4, T3.4). Before writing the fresh value, `applySuccess` sets `record.prev = shared` for every live snapshot. So if a fetch lands while an optimistic mutation is pending, a later rollback restores *server truth* rather than the pre-fetch baseline the snapshot captured. Without that, a refetch mid-mutation followed by a mutation failure would resurrect stale pre-fetch data. Pinned by R-Q3.4.

`InfiniteEntry` rebases on each of its success paths too (1.0). A refetch sets every live snapshot's `prev` and `prevParams` to the refetched pages (`infinite.ts:436-442`). `fetchNextPage` appends the new page and its param to each baseline, and `fetchPreviousPage` prepends them (`infinite.ts:508-513`, `infinite.ts:567-571`). A rollback after a page fetch then drops the optimistic change and keeps the page. Before, it restored the pre-fetch pages and lost the appended one. Pinned by `infinite-rebase.test.ts`.

`setData(updater, { track: false })` is a **canonical cache write**. It writes `data` but pushes NO snapshot and does NOT flip `hasPendingMutations`, returning a no-op `Snapshot`. It rebases every live snapshot onto the written value, as a fetch success does, so a later rollback restores this write rather than an older baseline (`entry.ts:672-674`). Tracked writes do not rebase: an optimistic layer is a guess. Two `QueryClient` paths call it:

- **The app's canonical writes.** `query.write(...)` and `query.replace(...)`, bound or unbound, reach `client.writeData` and `client.replaceData` (`client.ts:1594-1667`). A `createRealtimePatcher` handler writes this way, typically through a `bindQuery(ctx, query, { origin })` handle, so cross-tab leaves the write alone (`client.ts:224-233`).
- **A plugin's canonical writes.** `host.queries.write` and `host.queries.replace` reach `client.writeByKey` (`client.ts:1024-1061`), which addresses the entry by query id and `keyArgs` and skips an absent entry. Cross-tab applies a peer's write this way, and entities backprops an entity patch this way.

The untracked path is why a fire-and-forget write can no longer wedge `hasPendingMutations` at `true`. The T1.1 bug was exactly that those callers went through the tracked path and discarded the returned snapshot. A replace also calls `supersedeByWrite` on the entry when it leaves the entry holding data, so a fetch in flight cannot land over the record (below). `InfiniteEntry.setData` mirrors the same `track` option, with `pageParams`. Pinned by `regressions.test.ts` (R-Q1.1). Why canonical and optimistic writes are separate methods: `../decisions/canonical-vs-optimistic-writes.md`.

Hydration is a third canonical path, with its own method: `applyHydration` (`entry.ts:505-540`). It also rebases live snapshots, bumps `currentFetchId` so a fetch in flight cannot land, and takes the server's `lastUpdatedAt`.

The stack is what enables positional rollback: when top-of-stack mutation B rolls back, data goes to "state after mutation A's update" because that was the value B captured at its setData. Non-top rollbacks chain-splice instead (above). Spec §6.4.

## A replace that discards an invalidation's fetch catches up (1.0)

`supersedeByWrite(hasSubscribers)` (`entry.ts:619-636`) is what every `replace` path calls in place of `cancel()`: `client.replaceData`, `client.replaceInfiniteData`, the host's `replace` through `writeByKey`, and `LocalCache.replace`. It cancels the fetch in flight. When the entry is force-stale, meaning an invalidation marked it and no fetch has succeeded since, and `hasSubscribers` holds, it starts one catch-up fetch in the same `batch`. `isFetching` therefore never reads `false` between the two, so `waitForIdle()` cannot resolve in the gap.

The reason is reconciliation. A reconnect's `invalidateAll()` asks for what the app missed, and a pushed `replace` landing mid-fetch discarded exactly that response while carrying only its own record. Before 1.0, nothing re-ran it: `forcedStale` is cleared only by a success, focus refetch is off by default, and a subscribed reader does not re-acquire.

Two rules keep it bounded:

- **Coalesced.** `catchUpFetchId` records the catch-up's `currentFetchId`. A `replace` while it is in flight returns early and leaves it running, so a burst of pushes lands as writes and one request reconciles them. The catch-up's response lands over those writes, because it is the server truth the invalidation waits for.
- **Once, for an invalidation only.** A replace over a plain refetch, an interval tick or a first load is a plain supersede, because the entry is not force-stale. So is one over an entry nobody subscribes to.

`invalidate()` follows the catch-up. `followRedirects` (`entry.ts:89-109`) builds the promise over the refetch and registers a redirect for it in `redirects`. `supersedeByWrite` calls that redirect with the catch-up request, so the promise settles with the catch-up, without waiting for the discarded fetcher to honour its abort. A catch-up failure therefore reaches `onError` through `invalidateEntry`, like the invalidation's own. Another supersede, such as a newer refetch or a `cancel`, still resolves it as before. `InfiniteEntry.supersedeByWrite` (`infinite.ts:709-730`) mirrors all of it; its catch-up re-fetches every loaded page, and a page request on a force-stale entry is covered too. Pinned by `catch-up-refetch.test.ts`, whose first test is a code reviewer's reproduction.

## cancel

`cancel()` (`entry.ts:590-600`) aborts an in-flight fetch on demand without touching `data`. It bumps `currentFetchId`, so the running `runWithRetry` loses its supersede check and never writes, aborts `currentAbort`, and restores a settled status: `'success'` if data exists, else `'idle'`. It is a no-op when nothing is fetching. It is the primitive behind the public `query.cancel(...)` and `subscription.cancel()`, wired in `actions.ts:36-41` through `client.cancel` and `cancelAll` to `entry.cancel`. It is also the primitive behind the canonical optimistic recipe: cancel outgoing refetches before an optimistic `setData` so a stale response cannot clobber it (spec §5.5, §6.4). `InfiniteEntry.cancel` mirrors it, and also clears the per-direction paging flags. Pinned by R-Q3.4.

## firstValue / dispose

`firstValue()` resolves with the next successful data (or rejects on error). If already settled when called, resolves/rejects synchronously via `Promise.resolve` and `Promise.reject`. While pending, the resolver is tracked in `pendingFirstValueRejects: ((err: unknown) => void)[]` so `dispose()` can reject all outstanding `firstValue()` promises with `DOMException('Entry disposed', 'AbortError')` (see `entry.ts:741-768` and `entry.ts:781-813`).

`dispose()` aborts current fetch, clears the staleness timer, marks `disposed: true`, clears `isFetching` and `isLoading`, and rejects pending `firstValue()` promises and deferred fetches. Idempotent.

## Hydrated entries

When `client.bindEntry(...)` finds a buffered payload for the key, it passes the data and timestamp to the new entry as `initialData` and `initialUpdatedAt` (`client.ts:1362-1367`). The constructor then seeds `status: 'success'` and derives `isStale` from `Date.now() - lastUpdatedAt` (see `entry.ts:208-230`). If the data is fresh enough that the remaining stale window is above zero, the constructor also schedules a partial-length timer. The entry then flips to stale at the correct wall-clock moment, preserving stale-time semantics across the SSR boundary.

## Expiry scheduling

`scheduleExpiry` in `expiry-timer.ts` returns a cancellation closure, or `null` for a non-finite delay. `null` is the "nothing scheduled" state the callers already check for, so `Infinity` means *no timer* rather than a clamped one. Finite delays beyond 2,147,483,647 ms are walked in chunks against an absolute deadline. Fetch success, initial hydration and streaming hydration share this scheduler; infinite queries use it too. Disposal invokes the closure, clearing the current chunk. Explicit invalidation still marks an `Infinity` entry stale.

The same scheduler backs the **gc** timer in `ClientEntry` and `InfiniteClientEntry`, at `client.ts:365`, `:471`, `:642` and `:704`, and the refetch-interval chain at `client.ts:406` and `:669`. That is why `gcTime: Infinity` retains a released entry for the life of the root. In 0.8 the stale and gc timers had the same defect. A bare `setTimeout` clamps an out-of-range delay to about 1ms, so the two settings that mean "keep this the longest" behaved as the shortest. See `pitfalls/isstale-needs-timer.md`. Covered by `packages/core/tests/expiry-timers.test.ts`.
