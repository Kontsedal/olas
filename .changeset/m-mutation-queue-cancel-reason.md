---
"@kontsedal/olas-core": minor
"@kontsedal/olas-mutation-queue": patch
---

**The mutation queue no longer replays a run the app dropped, and no longer loses a `serial` queue on reload.**

- **New: `reason` on a `'cancel'` mutation event.** It is `'superseded'` for a `latest-wins` run a newer run replaced, `'reset'` for a run `reset()` dropped, and `'dispose'` when the controller that owned the run was disposed. The first two are the app discarding the run on purpose. `'dispose'` only means the screen is gone.
- **New: a `'queued'` mutation event.** A `serial` run that waits behind another reports `'queued'` when `run(...)` is called, under the `runId` it keeps, and `'start'` when its turn comes. A queued run that never starts still reports one outcome: `'cancel'` when `reset()` or a dispose drops it, or `'error'` when its `onMutate` throws. A plugin that treats every phase other than `'start'` as a settle should handle `'queued'` first.
- **A superseded or reset run is no longer replayed.** The queue kept the entry of every cancelled run, on the premise that a reload mid-run looks like a cancel. It does not: plugin delivery closes before a root disposes, and an unload emits nothing. The cancels the queue saw were supersedes and resets. An autosave with `latest-wins` and `persist: true` left each superseded draft on disk, and the next reconnect, `replayNow()` or page load sent it after the newer draft had landed. The queue now deletes the entry on `'superseded'` and `'reset'`, and keeps it on `'dispose'`.
- **Runs queued behind a hanging request survive a reload.** The queue wrote an entry when a run started, and a queued `serial` run started only when the run ahead of it settled. When the first request hung or backed off, storage held that request alone. The queue now writes each run when it is queued, in call order.
- **A replay releases the dedupe key of the entry it drops.** After an in-session failure was replayed, the `dedupeBy` key still pointed at the deleted entry. The next run with that key collapsed onto it, wrote no entry, and was lost on a reload.
