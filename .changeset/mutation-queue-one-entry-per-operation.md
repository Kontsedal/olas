---
"@kontsedal/olas-mutation-queue": patch
"@kontsedal/olas-core": patch
---

Stop the queue from replaying a write the server already took.

- **A manual retry no longer leaves a second entry.** A failed run keeps its durable entry so the next page load can replay it. The user presses the button again instead of waiting. That retry is a new `runId`, so its success dropped only its own entry, and the next load replayed the first one and wrote twice. A run that succeeds now also drops the entries left by earlier runs of the same logical operation that settled in error. Identity is `dedupeBy(mutationId, variables)` when configured, otherwise the `mutationId` plus the JSON form of the variables. Runs still executing keep their own entry, and a `cancelled` run keeps its own as before.
- **A `dedupeBy` collapse now settles the entry it collapsed onto.** The collapsed run wrote no entry. Its settle therefore deleted a key that never existed, and left the owner's entry on disk to replay a write the collapse had already landed.
- **A replay pass skips runs executing in this tab.** A run's entry is on disk for the whole window between its enqueue and its settle. An `online` event or a `replayNow()` landing in that window found the entry and fired the same request again. Cross-tab overlap is unchanged: the replay lock and the server's idempotency key still cover it.
- **`dispose()` releases a pass parked on the offline wait.** A tab that disposed while offline held the cross-tab replay lock. It also leaked the `online` listener the wait had registered. Both survived until a network that may never return.
- Correct the documented contract of `MutationEnqueueEvent.attempt` in `@kontsedal/olas-core`: exactly one enqueue fires per run and `attempt` is always `0`. The in-process retry loop reuses the `runId` and emits nothing, so a plugin counting cross-load attempts keeps its own tally — which the queue always did.
