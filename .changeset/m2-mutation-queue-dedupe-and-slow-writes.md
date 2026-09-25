---
"@kontsedal/olas-mutation-queue": patch
---

**`dedupeBy` no longer loses a queued `serial` run or replays a superseded draft, and a run superseded during a slow write sends nothing.**

- A queued `serial` run with the same `dedupeBy` key as the run ahead of it collapsed onto that run's entry. The run ahead settled first and took the entry with it, so the queued run went out with nothing on disk. A reload lost it, and a dispose replayed only the first run. A queued run now writes an entry of its own.
- A `latest-wins` run superseded by one with the same key kept its entry for the successor, with its own older variables. A dispose, a retryable failure or a reload then replayed the stale draft. The entry now takes the newest collapsed run's variables once its owner settles. A run that collapses onto an entry kept after a dispose or a retryable failure rewrites it before its request goes out. With `dedupeBy`, a success under the key also drops the entries disposed runs left under it.
- On an async storage, a run superseded while its entry was being written still called `mutate` once the write landed. A `mutate` that ignores its signal sent the stale request. The queue now skips the call.
