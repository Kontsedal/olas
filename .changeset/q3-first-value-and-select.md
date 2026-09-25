---
"@kontsedal/olas-core": patch
---

**`firstValue()` never waits on nothing, and `select` is never called with `undefined`.**

A `cancel()` of the first load left `firstValue()` pending for good, so a Suspense boundary kept its fallback up. A cancel while it waits now makes the entry fetch again, unless data arrives first, as the optimistic write that usually follows a cancel does. `firstValue()` called on an idle entry with nothing coming, such as after a `reset()` of a failed first load, starts a fetch. `firstValue()` and `refetch()` also skip `select` for an `undefined` value, as `data` already did, where they rejected with the projection's `TypeError`.
