---
"@kontsedal/olas-core": patch
---

**`prefetch` settles when its fetch is cancelled, and `prefetchInfinite` joins a fetch in flight.** A `cancel()` on an entry without data left a pending `prefetch` waiting forever, holding the entry: it was never gc'd, and `invalidate` refetched it as if subscribed. The prefetch now rejects with an `AbortError` when a cancel leaves no data, and resolves with the data a cancel keeps. A prefetch that joins a fetch in flight settles with that fetch, not with the stale data it replaces. `prefetch` on an infinite query now joins a request in flight instead of restarting it, and a supersede resolves it with the eventual result instead of rejecting.
