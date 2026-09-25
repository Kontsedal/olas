---
"@kontsedal/olas-core": patch
---

**`retry: false` on a mutation never retries, as SPEC §5.2 says.**

The mutation runner called any `retry` that was not a number, so `retry: false` failed the run with "retry is not a function". The error `mutate` threw was lost, and `onError` and the `error` signal received the `TypeError`. The runner now calls only a function `retry`. A number caps the attempts, and anything else means no retry.
