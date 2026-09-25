---
"@kontsedal/olas-core": patch
---

**`fakeAsyncState().firstValue()` checks data first, and every `deselect` ends a shift-click run.**

A `fakeAsyncState` given both `data` and an `error` rejected `firstValue()` with the error. A real subscription resolves with the data it kept through a failed refetch, and the fake now does the same.

`selection.deselect(id)` for an id that was not selected left a shift-click run going, where every other programmatic call ends it. The next shift-click then computed its range against the stale snapshot. It now ends the run too.
