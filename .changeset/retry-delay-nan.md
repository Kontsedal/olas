---
"@kontsedal/olas-core": patch
---

**A `retryDelay` of `NaN` retries at once instead of hanging.**

The retry sleep read a `NaN` delay as "never", as it reads `Infinity`. A query or mutation whose `retryDelay` computed `NaN` then sat at `isFetching: true` or `isPending: true` with no retry, until something aborted it. A `NaN` delay now means "retry now".
