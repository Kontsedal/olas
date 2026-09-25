---
name: entry
description: Per-cache-key state machine — race protection, retry, snapshot stack, staleness timer.
type: entity
covers:
  - packages/core/src/expiry-timer.ts
  - packages/core/src/query/entry.ts
  - packages/core/src/query/infinite.ts
  - packages/core/src/query/local.ts
  - packages/core/src/query/client.ts:1170-1213
  - packages/core/src/query/client.ts:1786-1947
edges:
  - { type: tested-by, target: ../../packages/core/tests/query-focus-online.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/expiry-timers.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/catch-up-refetch.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/retry-policy-throws.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-rebase.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/invalidation-outlives-older-fetch.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/prefetch-settles.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/retry-false.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/use-edges.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/optimistic-staleness.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/optimistic-layers.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-edges.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/property/entry.property.test.ts }
  - { type: uses, target: ../modules/signals.md }
  - { type: related, target: ../pitfalls/isstale-needs-timer.md }
  - { type: related, target: ../pitfalls/visible-data-is-not-a-baseline.md }
  - { type: related, target: ../decisions/canonical-vs-optimistic-writes.md }
last_verified: 2026-09-25
confidence: high
---

# `Entry<T>`

The per-cache-slot state machine, one `Entry<T>` per unique key. `LocalCache` uses one anonymous entry per controller. `ClientEntry` shares one per `(Query, keyHash)` pair. Spec §5, §21.6.

## Public signals (the AsyncState surface)

`data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`, `isPaused` (`entry.ts:204-214`). `AsyncState.isEnabled` belongs to the subscription in `use.ts`, because an entry has no `enabled` switch.

`isPaused` is `true` while a fetch is parked waiting for reconnect. Two paths park. The `online`-mode offline-defer path sets it in `scheduleDeferredFetch` and clears it in `startFetch`'s batch. The `offlineFirst` park path takes a `fetch` `TypeError` raised while `navigator.onLine === false`, resets to a settled status, then calls `scheduleDeferredFetch`. `always` mode never parks. Spec §5.5, T3.5. Pinned by `query-focus-online.test.ts` (R-Q3.5).

Each park settles the flags and sets `isPaused` in one `batch`, so no observer sees the entry idle and unpaused in between. `settled()` (below) reads that combination as a cancel. For the same reason `InfiniteEntry.drainDeferred` clears `isPaused` in the batch that starts its first request.

The park ends in `drainDeferred`, which starts one fetch and settles every parked waiter with it. The entry's own `online` listener calls it. `resumeParked()` (`entry.ts:438-440`) calls it too, but only while `navigator.onLine` does not read false. The client's interval, focus and reconnect triggers call `resumeParked` for a parked entry instead of starting a fetch (1.0, second pass). Before, they skipped a parked entry and left it to the `online` event. A worker has no `window` to fire that event, and jsdom can fire it while `navigator.onLine` still reads false, so the entry stayed parked for good. `InfiniteEntry.drainDeferred` resolves an `'initial'` waiter with the first page, as `startFetch` resolves: it used to resolve every waiter with nothing, and a `prefetch` requested offline resolved `undefined`. Pinned by `query-focus-online.test.ts`, "offline and reconnect scheduling", and `coverage-query-no-window.test.ts`.

**Any fetch made online ends the park (1.0, fourth pass).** A `refetch()` made once the network was back, before an `online` event reached the entry, cleared `isPaused` and left the waiters and the reconnect listener. The parked `invalidate()` never settled, and the later event made one more request, aborting work in flight (§5.9: one event, one request). Now `startFetch` hands the park to the request it just started through `adoptPark` (`entry.ts:470-480`): the waiters settle as that request does, and the listener goes. `InfiniteEntry.startFetch` does the same, and runs the parked page requests after the refetch, as the drain would (`runParked`, `infinite.ts:1408-1419`). An online `fetchNextPage` or `fetchPreviousPage` serves the parked requests of its own direction and leaves the others parked (`adoptParked`, `infinite.ts:738-755`). Pinned by `query-focus-online.test.ts`, "a fetch made online ends a park no online event reached".

## Race protection

`currentFetchId: number` (monotonic) + `currentAbort: AbortController | null`. Each `startFetch()` (`entry.ts:339-391`):

1. Increments `currentFetchId`.
2. Aborts the previous `currentAbort` (cancelling any in-flight fetcher).
3. Allocates a new `AbortController`.
4. Runs `runWithRetry(myId, abort, staleEpoch)` inside `releaseOnSettle`. `staleEpoch` is the entry's `staleEpoch` at the start (see Staleness).

In `online` mode while offline, `startFetch` parks instead. It first cancels the fetch in flight through `cancelInFlight`, in the same `batch` as the park, because a request made online supersedes it too (§5.5). Parking without the supersede let the older response land: a local cache whose key changed offline showed the old key's data. `cancelInFlight` is the in-flight half of `cancel()`, and leaves an existing park alone, so a second offline request joins it. Pinned by `query-focus-online.test.ts`, "a fetch requested offline supersedes the one in flight".

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

**The two abort cases are not the same, and the order of those checks is the whole distinction** (`entry.ts:495-562`, `runWithRetry`). Four engine paths abort the controller: `startFetch`, `cancel`, `applyHydration`, `dispose`. Each bumps `currentFetchId` or sets `disposed` first, and each writes the entry's state itself or hands it to the superseding fetch. Such a fetch must write nothing: §5.6, "errors from outdated fetches are also dropped".

An `AbortError` that arrives while this fetch is still `currentFetchId` therefore did **not** come from the engine. It came from the fetcher: its own `AbortSignal.timeout`, an axios cancel token, a rethrown stale abort. Nothing is coming to settle the entry after it, so it settles like any other failure: `status: 'error'`, `error` set, `isFetching` and `isLoading` cleared, `data` untouched.

Rethrowing it, which the single fused check did, left `isFetching` true with nothing to clear it. The spinner then runs until the entry is disposed, `root.waitForIdle()` does not resolve during SSR, and `firstValue()` does not settle under Suspense. The retry policy stays out of it, as it does for every abort. Pinned by `regressions.test.ts` under "a fetcher-originated AbortError settles the entry", which also pins the converse: a superseded fetch aborting late must not clear the newer fetch's `pending`.

**An outdated fetch's caller hears the supersede, not its error (1.0).** The superseded branch rethrew the fetch's own error. The caller then saw a real failure for a request whose result §5.6 says is dropped: `invalidateEntry` routed it to `onError` as a cache error, and `prefetch` rejected with it instead of resolving with the value that won. It now throws `AbortError('Superseded')`, the same as an outdated request that succeeds, and both callers already treat that as a supersede. `InfiniteEntry` does the same in both loops. Pinned by `regressions.test.ts`, "outdated fetches and late releases" and "infinite queries".

**A settled request lets go of its `AbortController` (1.0).** `releaseOnSettle` clears `currentAbort` when the request that owns it settles, in both entry classes. Before, the next fetch, a hydration, a cancel or dispose aborted a finished request's controller. That cancelled nothing, fired late `abort` listeners on the fetcher's `signal`, and cost a `DOMException` per call, which was half of a 1,000-query root's CPU time (`decisions/benchmarks.md`).

**A page request clears `isLoading` when it starts (1.0).** It only starts once pages exist, so the entry is not loading for the first time. A write landing during the first load, followed by `fetchNextPage()`, used to leave `isLoading` true for good: the page request superseded the first load, and neither settled the flag.

**Paging before the first page joins the first load (1.0, fourth pass).** `fetchNextPage()` or `fetchPreviousPage()` with no page loaded called `startFetch()`, which aborted the first load and started it over: two calls made three requests, two of them aborted. `joinFirstLoad` (`infinite.ts:727-731`) now returns the request in flight and starts one only when none runs. Pinned by `infinite-edges.test.ts`, "paging during the first load joins it".

`InfiniteEntry` makes the same split in both of its loops (`runRefetchAll` and `runFetch` in `query/infinite.ts`). Each loop settles a failure through `settleFailure` (`infinite.ts:1329-1346`): `error` set, `status: 'error'`, `isFetching` and `isLoading` cleared, and for a page fetch the direction flag cleared too. Loaded pages stay. The retry policy is skipped for an abort there as well. Pinned by `regressions.test.ts` under "a fetcher-originated AbortError settles an infinite entry".

`retry`: `false | number | (attempt, err) => boolean`, where `false` means never, as `0` does (spec §5.2; pinned by `retry-false.test.ts`). `retryDelay`: `number | (attempt) => number`. The default is `retry: 0`. With retries on and no `retryDelay`, the delay is exponential, `min(1000 * 2 ** attempt, 30_000)` ms (`computeDelay`, `entry.ts:571-578`, T3.9).

A retried fetch is one logical fetch to the consumer — `isFetching` stays true the whole time, only the final outcome reaches `data`/`error`.

**A throwing `retry` or `retryDelay` callback fails the attempt (1.0).** Both callbacks run inside the loop's `catch`. A throw there used to escape the loop: the fetch promise rejected, and `isFetching` stayed true with nothing to clear it, the same wedge as the fetcher-originated abort. Now the throw is that attempt's failure, settled through `applyFailure` with the thrown error (`entry.ts:553-556`). `InfiniteEntry` does the same in both loops, through `nextRetryDelay` and `settleFailure` (`infinite.ts:1316-1346`). The mutation runner never wedged: its `runWithRetry` rejects, and the run's own `catch` settles it. Pinned by `retry-policy-throws.test.ts`, the mutation case included.

**Each failure is recorded for `ErrorContext`.** `applyFailure` stores `{ error, attempt, cause? }` as `lastFailure`, with `cause` present only when a policy callback threw. `failureOf(err)` (`entry.ts:804-806`) returns `attempt` and `cause` when `err` is that failure, and `client.invalidateEntry` spreads them into the `kind: 'cache'` context. `InfiniteEntry.failureOf` mirrors it. See `../modules/errors.md`.

## Staleness

`isStale: Signal<boolean>`, NOT a computed. Why: a computed over `Date.now()` would only re-evaluate when the timestamp it reads changes; the passage of time alone wouldn't trigger anything. Instead, every write of server truth calls `settleStaleness(at)` (`entry.ts:692-706`), which sets `isStale` from the age of `at` and arms a timer for the rest of `staleTime`. The constructor calls it for hydrated data, and `applySuccess`, `applyHydration` and a canonical `setData` call it with their stamp. `invalidate()` clears the timer and flips immediately. See `../pitfalls/isstale-needs-timer.md`.

**Staleness runs on the server's clock (1.0, third pass).** `isStaleNow()` (`entry.ts:1260-1274`) is the check a subscriber, `resume()`, a focus or reconnect trigger and `prefetch` consult. It reads `serverUpdatedAt` through `isServerStale`, where it used to read `lastUpdatedAt`. An optimistic `setData` moves `lastUpdatedAt` and not `serverUpdatedAt`, so a guess used to reset freshness. Past `staleTime`, a new subscriber then skipped its refetch while the guess was live, after its rollback (old server data passed for fresh) and after its finalize. The `isStale` signal read `true` in all three. Now both follow `serverUpdatedAt`, and an optimistic write touches neither the signal nor its timer.

**A live optimistic write holds a staleness fetch back.** Take a live snapshot on a server-stale entry with no standing invalidation. `isStaleNow()` answers `false` there, because the response would land over the guess on screen, and it sets `fetchHeldBack`. `forcedStale` still answers `true` first. When the last live snapshot settles, `rollback` and `finalize` call `runHeldBackFetch` (`entry.ts:1132-1148`). It decides one microtask later, so an `invalidate()` in the mutation's `onSuccess` or `onSettled` starts the only request. It fetches when the flag survived, no snapshot went live again, `hasSubscribers` holds, nothing is in flight, and the entry is still stale. A parked entry goes through `resumeParked` instead. Any `startFetch` clears the flag, parked or not.

The fetch runs only when one was held back, not whenever a held entry is stale at settle. With the default `staleTime: 0`, a held entry is always stale, so that rule would add a refetch after every optimistic mutation, including one whose `onSuccess` folds the server's response with `write`. SPEC §5.9 lists the refetch triggers and keeps them quiet, and a settle is not one. A `refetchInterval` tick does not consult staleness, so a live snapshot does not hold it back. A local cache never calls `isStaleNow()`, so its settles never fetch. Pinned by `optimistic-staleness.test.ts`.

A canonical write and an infinite page fetch now restart the timer too. `isStaleNow()` already counted both as fresh, because both moved `lastUpdatedAt`, but the signal kept its old value until the next fetch.

`markStale()` forces the entry stale **without fetching**: it clears the timer, sets `isStale`, and sets a private `forcedStale` flag so `isStaleNow()` returns true until data requested after it lands. It also bumps `staleEpoch` and records `staleSince = Date.now()`. A fetch passes the epoch it started under to `applySuccess`, which clears `forcedStale` only when no `markStale()` came after (`entry.ts:611`). A released entry keeps its fetch for the gc window, so a response requested before an invalidation can land after it. It used to clear the flag, and the next subscriber skipped the refetch; with `staleTime: Infinity` the old data stayed for good. A hydrated row clears the flag when it is stamped at or after `staleSince` (below). Pinned by `invalidation-outlives-older-fetch.test.ts`. `invalidate()` = `markStale()` + `startFetch()` (`entry.ts:781-801`). `client.invalidateEntry` calls `markStale()` alone for a subscriber-less entry (`client.ts:1651-1687`), so the next subscriber's staleness check refetches instead of waking data no subscriber watches (spec §5.7, T3.9). `InfiniteEntry` mirrors both.

**Data that lands and leaves the mark standing makes a held entry catch up (1.0, second pass).** A subscriber that returns while the older fetch still runs joins it: `use.ts` starts no fetch while `isFetching` is true, and neither do `resume()`, `prefetch` and `prefetchInfinite`. The older response then kept the mark with a subscriber already present, and nothing refetched, even with `staleTime: Infinity`. Now `applySuccess` calls `catchUpIfStillStale` (`entry.ts:647-649`) inside the batch that writes the data. When `forcedStale` survived and the `hasSubscribers` option says someone holds the entry, it starts one fetch through `startCatchUp` (`entry.ts:656-662`). `isFetching` therefore never reads false between the two, so a joined `prefetch` settles with the catch-up through `settled()`, and `waitForIdle()` keeps waiting. An `invalidate()` still waiting on the request that landed follows the catch-up through `redirects`. `ClientEntry` passes `hasSubscribers`, which counts a prefetch hold. A local cache passes `() => true`, and a bare `Entry` defaults to nobody. The devtools `onFetchSuccess` now fires inside that batch, before the catch-up's `onFetchStart`, so it still carries the landing fetch's `causeId`. `InfiniteEntry` catches up the same way after a refetch, and after a page from `fetchNextPage` or `fetchPreviousPage` while force-stale, since a page never clears the mark. The failure path does not catch up: a failed older fetch leaves `status: 'error'`, and a subscriber that arrives after it refetches on that. Pinned by `invalidation-outlives-older-fetch.test.ts`, "a subscriber that joins the older fetch still refetches".

## Snapshot stack (optimistic updates, §6.4)

`setData(updater, opts?)` (`entry.ts:924-1034`) defaults to the **tracked** (optimistic) path: it records `{ id, prev: previousData, updater, epoch, live: true }`, pushes onto `this.snapshots`, flips `hasPendingMutations`, and returns a working `{ rollback, finalize }`. The record keeps the updater because a commit re-runs it (below), and `epoch` is the entry's `serverEpoch` when the layer was pushed. The mutation runner calls `finalize` after a successful run's `onSuccess`, which drops the snapshot from the live set without reverting. `hasPendingMutations` clears once no live snapshots remain, and the last settle runs any fetch the live snapshot held back (Staleness, above). A tracked write moves `lastUpdatedAt` and leaves `serverUpdatedAt`, `isStale` and the stale timer alone. Either path flips an `idle` or `pending` entry to `success`.

The entry's settles return a `SettleReport` (`'commit'` or `null`), which the client turns into a plugin event (below). The type is `EntrySnapshot`, assignable to the public `Snapshot`.

**Rollback is chain-spliced, not a blind restore** (`entry.ts:976-1008`, spec §6.4). It marks the snapshot dead, then branches on its position in the live stack:

- **Top of the stack** (most-recent live snapshot): restore `data` to the snapshot's captured `prev`, then drop it. This is the LIFO case — the only one previously tested.
- **Not the top**: thread this layer's `prev` onto the layer above it with `snapshots[i+1].prev = record.prev`, drop it, then replay the layers above through `replayFrom` (below).

The invariant this guarantees: **rolling back every live snapshot — in any order — returns `data` to the bottom layer's baseline**, which is the original pre-mutation value plus every canonical write and commit since. The prior code restored `record.prev` unconditionally. An out-of-order rollback then resurrected A's delta and left the wrong final value: A and B both apply, A fails first, then B fails. Pinned by `regressions.test.ts` under R-Q3.1. `InfiniteEntry.setData` mirrors the same chain-splice, threading both `prev` (pages) and `prevParams`.

**A rollback below the top replays the layers above it (1.0, fourth pass).** Their baselines and the data on screen still held the failed layer's delta. Until this pass the chain-splice left them so, and the screen kept the failed guess while a layer above was live. Worse, when that layer committed, its settle reported the failed guess as `'commit'`: A and B apply, A fails, B succeeds, and persist stored `{ a: true, b: true }`. `replayFrom` (`entry.ts:1072-1096`) now rebuilds them from the baseline the removed layer restored. Each layer's baseline is the one below with that layer's updater applied, and `data` is the top's result, structurally shared with the value on screen so a replay that changes nothing keeps its reference and reports no write. The rules are the commit fold's:

- A layer a fetch or a hydrated row replaced while it was live (`epoch !== serverEpoch`) passes its baseline through. The read may hold its change, and it had already left the screen showing the read.
- A plain value, an updater with no parameters (`updater.length === 0`) such as a cross-tab mirror's `() => data`, is replayed but cannot drop a change it captured from the screen. The entry reconciles (`reconcileLater`). An updater with only a defaulted parameter also has length 0, so it reconciles too, which costs a refetch and is otherwise harmless.
- An updater that throws on the new baseline stops the replay and leaves the screen as it was, and the entry reconciles.

`InfiniteEntry.replayFrom` (`infinite.ts:1120-1152`) replays the pages, re-aligning each layer's params as its write did (the record keeps the `pageParams` it was given). Pinned by `optimistic-layers.test.ts`, "an out-of-order rollback leaves no guess behind", by R-Q3.1 in `regressions.test.ts`, whose middle step now expects the replayed value, and by both property models.

**Fetch success rebases live snapshots** (`entry.ts:584-605` in `applySuccess`, spec §6.4, T3.4). Before writing the fresh value, `applySuccess` sets `record.prev = shared` for every live snapshot. So if a fetch lands while an optimistic mutation is pending, a later rollback restores *server truth* rather than the pre-fetch baseline the snapshot captured. Without that, a refetch mid-mutation followed by a mutation failure would resurrect stale pre-fetch data. Pinned by R-Q3.4. It also bumps `serverEpoch`, and so does `applyHydration`: a commit uses it (below).

`InfiniteEntry` rebases on each of its success paths too (1.0). A refetch sets every live snapshot's `prev` and `prevParams` to the refetched pages (`infinite.ts:563-569`). `fetchNextPage` appends the new page and its param to each baseline's `prev` and `prevParams`, and `fetchPreviousPage` prepends them (`infinite.ts:641-644`, `infinite.ts:699-702`). A rollback after a page fetch then drops the optimistic change and keeps the page. Before, it restored the pre-fetch pages and lost the appended one. A page fetch does not bump `serverEpoch`: it adds a page and leaves the others as they were. Pinned by `infinite-rebase.test.ts`.

**A canonical write patches every live baseline (1.0, fourth pass).** `setData(updater, { track: false })` is a **canonical cache write**. It writes `data` but pushes NO snapshot and does NOT flip `hasPendingMutations`, returning a no-op `Snapshot`. It sets `serverUpdatedAt` and restarts the stale timer through `settleStaleness`. It re-runs its updater on every live snapshot's baseline through `rebaseOnto` (`entry.ts:1041-1057`), so a later rollback restores the server value with this write in it. Until this pass it set every baseline to the value on screen, which holds the live guesses. A push that patched a title during a pending like then made the like permanent when the mutation failed. See `../pitfalls/visible-data-is-not-a-baseline.md`. A `replace` passes `whole: true`, and its value becomes every baseline as before (`entry.ts:939`). `InfiniteEntry.setData` does the same, and re-aligns each baseline's params to its own new page count (`alignParams`, `infinite.ts:209-222`). Tracked writes do not rebase: an optimistic layer is a guess. Pinned by `optimistic-layers.test.ts`, "a canonical write patches each live baseline", and by the property model. Two `QueryClient` paths call it:

- **The app's canonical writes.** `query.write(...)` and `query.replace(...)`, bound or unbound, reach `client.writeData` and `client.replaceData` (`client.ts:1786-1863`). A `createRealtimePatcher` handler writes this way, typically through a `bindQuery(ctx, query, { origin })` handle, so cross-tab leaves the write alone (`client.ts:316-324`).
- **A plugin's canonical writes.** `host.queries.write` and `host.queries.replace` reach `client.writeByKey` (`client.ts:1170-1213`), which addresses the entry by query id and `keyArgs` and skips an absent entry. Cross-tab applies a peer's write this way, and entities backprops an entity patch this way.

The untracked path is why a fire-and-forget write can no longer wedge `hasPendingMutations` at `true`. The T1.1 bug was exactly that those callers went through the tracked path and discarded the returned snapshot. A replace also calls `supersedeByWrite` on the entry when it leaves the entry holding data, so a fetch in flight cannot land over the record (below). Pinned by `regressions.test.ts` (R-Q1.1). Why canonical and optimistic writes are separate methods: `../decisions/canonical-vs-optimistic-writes.md`.

**A commit folds into the layers below it (1.0, fourth pass).** `finalize()` commits a layer as server truth. The layers still live below it captured their baselines before it applied, so `finalize` re-runs the committed layer's updater on each of them through `rebaseOnto` (`entry.ts:1009-1033`). Before, finalize only dropped the record. Two parallel toggles then lost a commit: A and B apply, B succeeds, A fails and restores a baseline from before B. The layers above the committed one need nothing, because their baselines already hold its change.

The fold is skipped when `record.epoch !== serverEpoch`: a fetch or a hydrated row landed while the layer was live. That read set every baseline to server truth, which may already hold the committed change, and re-running a toggle there would flip it back. The read stands then, as it did before, which matches a single layer's behaviour. Pinned by `optimistic-layers.test.ts`, "a committed layer folds into the baselines below it", including "a layer live across a fetch does not fold again".

**A baseline the updater throws on makes the entry reconcile.** An updater can throw on a baseline it was not written for. Two cases: `p!.title` on the `undefined` under a guess made before the first load, and a patch that only fits the guessed data. `rebaseOnto` then keeps that baseline, warns in development (`warnBaselineThrow`), and calls `reconcileLater` (`entry.ts:1103-1106`). That marks the entry stale, as an invalidation does, and sets `fetchHeldBack`, so the last settle fetches if someone holds the entry. Either choice of value would be known to be wrong, and a refetch is the one way to the truth. `InfiniteEntry` does the same. Pinned by the two "throws on a baseline" tests in `optimistic-layers.test.ts`.

**A commit is reported once no layer is live (1.0, fourth pass).** `settleReport` (`entry.ts:1114-1122`) decides what a settle reports. A finalize that leaves no live layer reports `'commit'`. A finalize under another live layer sets `commitPending` and reports nothing, because the data on screen still holds that layer's guess. The settle that clears the last live layer then reports `'commit'`, even a rollback, whose restored baseline has the commit folded in. A fetch or a hydrated row clears `commitPending`, since its own event carries the server truth. The client emits the event (`emitCommit`, `client.ts:1934-1947`). Pinned by `plugin-host.test.ts`, "onWrite — commit".

Hydration is a third canonical path, with its own method: `applyHydration` (`entry.ts:736-772`). It also rebases live snapshots, bumps `currentFetchId` so a fetch in flight cannot land, and takes the server's `lastUpdatedAt`. A row stamped before the entry's `serverUpdatedAt` is older than what the server last said: `applyHydration` skips it and returns `false`, and the client then reports no write. A stamp from the future is read as now through `notInFuture` (`entry.ts:180-184`). The row clears `forcedStale` only when it is stamped at or after `staleSince`. Pinned by `ssr.test.ts`, "live hydration" and "a server clock ahead of the client".

**`serverUpdatedAt` is not `lastUpdatedAt` (1.0, second pass).** A fetch success, a hydrated row and a canonical `setData(..., { track: false })` set both. An optimistic `setData` moves only `lastUpdatedAt`, and a commit moves neither. Staleness reads `serverUpdatedAt` too since the third pass (above). The skip rule compared against `lastUpdatedAt`, so a guess outranked the server: fetched at 1000, an optimistic write at 5000 and its rollback, and a row stamped 3000 was dropped. During a live optimistic write the row was dropped too, where §6.4 says server truth becomes the rollback baseline. `InfiniteEntry` keeps the same field, and a page fetch sets it. `serverStamp()` reads it for the client. Pinned by `ssr.test.ts`, "an optimistic write does not make a newer server row look old".

**A row stamped before an invalidation catches up (1.0, second pass).** Such a row leaves `forcedStale` in place, yet it has superseded the fetch the invalidation started. With a subscriber present, nothing then fetched, and the entry sat stale over the row. `applyHydration` now calls `catchUpIfStillStale` in its batch, with the discarded request, so an `invalidate()` waiting on it follows the catch-up. `InfiniteEntry.applyHydration` does the same. Pinned by `ssr.test.ts`, "a row stamped before an invalidation re-runs the fetch it discarded".

The stack is what enables positional rollback: when top-of-stack mutation B rolls back, data goes to "state after mutation A's update" because that was the value B captured at its setData. Non-top rollbacks chain-splice instead (above). Spec §6.4.

## What `dehydrate()` ships (1.0, fourth pass)

`serverState()` (`entry.ts:1291-1297`) is the row `dehydrate()` ships. Under a live layer it is the bottom baseline, with every canonical write and commit folded in, so a guess never travels as server truth. It is stamped with `serverUpdatedAt`, or `0` when the server never answered. Before, `dehydrate()` shipped the data on screen stamped with `lastUpdatedAt`, which a guess moves and its rollback leaves. Data fetched at 1000, with a guess at 5000 and its rollback at 6000, shipped stamped 5000. `null` means no data and no server answer, so an optimistic write rolled back on an entry the server never answered ships nothing. `InfiniteEntry.serverState` returns the pages and their params the same way. Pinned by `ssr.test.ts`, "dehydrate ships server truth, stamped by the server clock".

## A replace that discards an invalidation's fetch catches up (1.0)

`supersedeByWrite()` (`entry.ts:895-905`) is what every `replace` path calls in place of `cancel()`: `client.replaceData`, `client.replaceInfiniteData`, the host's `replace` through `writeByKey`, and `LocalCache.replace`. It cancels the fetch in flight through `cancelInFlight`. When the entry is force-stale, meaning an invalidation marked it and no fetch has succeeded since, and the `hasSubscribers` option holds, it starts one catch-up fetch in the same `batch`, through `catchUpIfStillStale`. The landing and hydration catch-ups above share that path, and `supersedeByWrite` took `hasSubscribers` as an argument before they existed. `isFetching` therefore never reads `false` between the two, so `waitForIdle()` cannot resolve in the gap.

The reason is reconciliation. A reconnect's `invalidateAll()` asks for what the app missed, and a pushed `replace` landing mid-fetch discarded exactly that response while carrying only its own record. Before 1.0, nothing re-ran it: `forcedStale` is cleared only by data requested after the invalidation, focus refetch is off by default, and a subscribed reader does not re-acquire.

Two rules keep it bounded:

- **Coalesced.** `catchUpFetchId` records the catch-up's `currentFetchId`. A `replace` while it is in flight returns early and leaves it running, so a burst of pushes lands as writes and one request reconciles them. The catch-up's response lands over those writes, because it is the server truth the invalidation waits for.
- **Once, for an invalidation only.** A replace over a plain refetch, an interval tick or a first load is a plain supersede, because the entry is not force-stale. So is one over an entry nobody subscribes to.

`invalidate()` follows the catch-up. `followRedirects` (`entry.ts:152-172`) builds the promise over the refetch and registers a redirect for it in `redirects`. `supersedeByWrite` calls that redirect with the catch-up request, so the promise settles with the catch-up, without waiting for the discarded fetcher to honour its abort. A catch-up failure therefore reaches `onError` through `invalidateEntry`, like the invalidation's own. Another supersede, such as a newer refetch or a `cancel`, still resolves it as before. `InfiniteEntry.supersedeByWrite` (`infinite.ts:882-899`) mirrors all of it; its catch-up re-fetches every loaded page, and a page request on a force-stale entry is covered too. Pinned by `catch-up-refetch.test.ts`, whose first test is a code reviewer's reproduction.

## cancel

`cancel()` (`entry.ts:828-849`) aborts an in-flight fetch on demand without touching `data`. It bumps `currentFetchId`, so the running `runWithRetry` loses its supersede check and never writes, aborts `currentAbort`, and restores a settled status: `'success'` if data exists, else `'idle'`. It is a no-op when nothing is fetching or parked. It is the primitive behind the public `query.cancel(...)` and `subscription.cancel()`, wired in `actions.ts:36-41` through `client.cancel` and `cancelAll` to `entry.cancel`. It is also the primitive behind the canonical optimistic recipe: cancel outgoing refetches before an optimistic `setData` so a stale response cannot clobber it (spec §5.5, §6.4). `InfiniteEntry.cancel` mirrors it, and also clears the per-direction paging flags. Pinned by R-Q3.4.

**A parked fetch is cancelled too (1.0, fourth pass).** `cancel()` returned early when nothing was in flight, so a fetch parked for the network survived it. The reconnect then ran it, and its response landed over the optimistic value the recipe had written next. Now `dropPark` (`entry.ts:487-493`) clears `isPaused`, removes the reconnect listener and rejects the parked waiters with an `AbortError`, as a cancelled request's callers are. `InfiniteEntry` drops parked refetches and page requests alike. Pinned by `query-focus-online.test.ts`, "cancel() drops a fetch parked for the network".

## firstValue / settled / dispose

`firstValue()` (`entry.ts:1160-1199`) resolves at once when the entry holds data (`!== undefined`), even while a background refetch runs or after one failed. Otherwise it waits for the first success, or rejects on the first failure (spec §5.3). A background refetch sets `status: 'pending'` over data, and `firstValue()` used to wait for it. Pinned by `use-edges.test.ts`, "firstValue resolves at once when data is present".

**It never waits on nothing (1.0, fourth pass).** A `cancel()` of the first load left the entry idle, with no fetch coming. A waiting `firstValue()` then never settled, and a Suspense boundary kept its fallback up for good. Now `firstValue()` starts a fetch on an idle entry with no data and nothing in flight or parked. That covers a call after the cancel and a `reset()` of a failed first load. A cancel while a `firstValue()` waits calls `recoverFirstValue` (`entry.ts:858-865`). One microtask later, unless data arrived meanwhile, the entry fetches again for the waiter. The microtask is for the recipe: `cancel()` then `setData(guess)` resolves the waiter with the guess and fetches nothing. The waiter never rejects for a cancel, because a Suspense consumer should load again, not show an error boundary. A React hook that suspends only while `status` reads `'pending'` sees that status, since the recovery fetch sets it. `firstValueWaiters` counts the waiters, so a cancel with none fetches nothing. `InfiniteEntry` mirrors it. Pinned by `use-edges.test.ts`, "firstValue never waits on nothing".

The data must belong to the current key (1.0, second pass). A `createCache` local cache with `keepPreviousData` keeps the previous key's data in its one entry after a key change, and `firstValue()` resolved with it. `LocalCacheImpl` now sets `previousKeyData` when its key effect sees a new key over data, and clears it in the entry's `onSuccessData`. While it is set, the cache's `firstValue` calls `settled()`, which waits for the new key's fetch. A shared query needs none of this, because a new key is a new entry. Pinned by `use-edges.test.ts`, "a local cache with keepPreviousData".

The local cache's key effect compares keys by `stableHash`, as `createQuery` does (1.0, fourth pass). It started a fetch on every run, so a key thunk that re-ran to an equal key refetched and aborted the request in flight, whatever the `staleTime`. An equal key now changes nothing. A key the hash cannot encode, such as a class instance, compares element by element (`identify` and `sameKey` in `local.ts`). Pinned by `cache.test.ts`, "ctx.cache — an equal key does nothing".

`settled()` (`entry.ts:1212-1247`) settles with the fetch in flight instead: the data at `success`, the error at `error`. A superseding fetch or a park keeps it waiting, and a `cancel()` that leaves no data rejects with an `AbortError`. `prefetch` and a subscription's superseded `refetch()` use it, because `firstValue()` would resolve with the stale data the refetch replaces. While pending, the resolver is tracked in `pendingFirstValueRejects: ((err: unknown) => void)[]` so `dispose()` can reject all outstanding `firstValue()` promises with `DOMException('Entry disposed', 'AbortError')` (see `entry.ts:1160-1199` and `entry.ts:1299-1331`).

`dispose()` aborts current fetch, clears the staleness timer, marks `disposed: true`, clears `isFetching` and `isLoading`, and rejects pending `firstValue()` promises and deferred fetches. Idempotent.

## Hydrated entries

When `client.bindEntry(...)` finds a buffered payload for the key (`client.ts:1537-1626`), it hands it to the new `ClientEntry`, whose constructor passes the data and timestamp to the entry as `initialData` and `initialUpdatedAt` (`client.ts:407-408`). The constructor then seeds `status: 'success'`, reads a future `lastUpdatedAt` as now, sets `serverUpdatedAt` to the stamp, and derives `isStale` from its age through `settleStaleness` (`entry.ts:320-337`). The stamp alone seeds `'success'`, so a row whose data is `undefined` reads as `applyHydration` gives it on a bound entry (1.0, fourth pass). It used to read `'idle'` with the server's stamp, so its subscriber saw `'pending'` and refetched despite `staleTime` (§21.9; pinned by `ssr.test.ts`, "a hydrated row with no data"). If the data is fresh enough that the remaining stale window is above zero, `settleStaleness` also schedules a partial-length timer. The entry then flips to stale at the correct wall-clock moment, preserving stale-time semantics across the SSR boundary.

## Expiry scheduling

`scheduleExpiry` in `expiry-timer.ts` returns a cancellation closure, or `null` for a non-finite delay. `null` is the "nothing scheduled" state the callers already check for, so `Infinity` means *no timer* rather than a clamped one. Finite delays beyond 2,147,483,647 ms are walked in chunks against an absolute deadline. Fetch success, initial hydration and streaming hydration share this scheduler; infinite queries use it too. Disposal invokes the closure, clearing the current chunk. Explicit invalidation still marks an `Infinity` entry stale.

The same scheduler backs the **gc** timer, `gcTimer`, in `ClientEntry` and `InfiniteClientEntry`, at `client.ts:461`, `:550`, `:735` and `:801`, and the refetch-interval chain, `intervalTimer`, at `client.ts:502` and `:762`. That is why `gcTime: Infinity` retains a released entry for the life of the root. In 0.8 the stale and gc timers had the same defect. A bare `setTimeout` clamps an out-of-range delay to about 1ms, so the two settings that mean "keep this the longest" behaved as the shortest. See `pitfalls/isstale-needs-timer.md`. Covered by `packages/core/tests/expiry-timers.test.ts`.
