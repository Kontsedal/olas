---
"@kontsedal/olas-mutation-queue": minor
---

**`isRetryable`, a devtools lane, and one replay order for every tab.**

- **New: `isRetryable(err, entry)`.** The queue treated every failure as transient, so a 422 that fails the same way on every load spent all `maxAttempts` before `onReplayError` fired. With `backoffMs` set, that took several page loads. Return `false` from `isRetryable` and the queue drops the entry at once and reports it through `onReplayError`. It asks about a live run's failure and a replay's. `mutate` is the app's own function, so the queue cannot read a status code itself: throw an error that carries one, and read it in `isRetryable`. The README has an example. A throw from `isRetryable` is reported through `onWarn`, and the entry stays. Without the option nothing changes.
- **Replays show on the devtools lane.** The queue sends each replay attempt, its result, and each entry a pass skipped through `host.debug`. A payload carries the entry's `mutationId` and `runId`, the attempt number, and the result or skip reason. The package now ships a development build behind the `development` export condition, like core, and only that build has this code. The production build and its size are unchanged.
- **Two tabs no longer replay tied entries in storage order.** `seq` is seeded from `Date.now()`, so two tabs that open in the same millisecond give unrelated entries the same `seq`. The replay order of those entries was the order the storage listed its keys, which differs between adapters and can differ between tabs. `runId` now breaks the tie. Every stored entry carries one, so entries written by earlier versions sort the same way, and the stored format is unchanged.
