---
"@kontsedal/olas-core": minor
---

**`retry: false` is accepted, and means never retry.** The spec allowed `retry: false`, but `RetryPolicy` had no `false`, and a JS caller passing it got "retry is not a function" reported as the fetch failure. `RetryPolicy` now includes `false`, and queries, infinite queries and root defaults treat it as `0`.
