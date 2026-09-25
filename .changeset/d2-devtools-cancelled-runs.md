---
"@kontsedal/olas-devtools": patch
---

**The panel pairs a mutation's settle with its own run, and closes a cancelled run.**

The store paired a settle with the oldest pending start of the same mutation. A superseded, reset or disposed run sends no settle, so its start stayed queued forever. Three `latest-wins` runs at 0, 100 and 200 ms whose last settled at 210 ms showed a 210 ms success, and each superseded run's timeline group stayed active.

The store now pairs by the run id core sends as `causeId`, and reads core's new `mutation:cancel`. A cancelled run ends its timeline group with `cancel` and the reason. The Mutations log adds a `cancel` entry with the reason and the duration, and the Tree's pending badge drops. `MutationEntry` gains the `cancel` kind. The store ignores a cancel with no start on record, such as the one core sends for a queued `serial` run dropped before it started. It keeps at most 1,000 unfinished starts.
