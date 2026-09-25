---
"@kontsedal/olas-core": patch
---

**A rollback keeps every canonical write and every committed layer made while it was live.**

A canonical `write` during a live optimistic write set the rollback baseline to the data on screen, guess included. A failed mutation then left its guess in place: a pushed title over a pending like kept the like. A `write` now re-runs its patch on each live baseline, and a `replace` value still becomes each one. A committed layer, which is what `finalize()` and a successful mutation make, is now folded into the baselines of the layers still live below it. An older mutation that fails no longer undoes a newer one that succeeded. A rollback of a layer below the top left its guess on screen while a layer above was live. A commit of that layer then reported the failed guess as committed truth. The layers above a removed one are now replayed over the baseline it restored, so the failed change leaves the screen at once. An updater can throw on a baseline it was not written for, and a plain value such as `() => data` may hold a change it captured. In both cases the entry marks itself stale and refetches once the last optimistic write settles. Infinite queries follow the same rules.
