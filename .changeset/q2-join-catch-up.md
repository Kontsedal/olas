---
"@kontsedal/olas-core": patch
---

**A subscriber that joins a fetch older than an invalidation still gets a refetch.**

An invalidation of an entry with no subscribers only marks it stale, and the next subscriber refetches. A subscriber that came back while a fetch requested before the invalidation was still running joined that fetch instead. The older response kept the stale mark, but nothing fetched again, even with `staleTime: Infinity`. `resume()`, `prefetch` and infinite queries did the same, and a `prefetch` resolved with the older data. Now, when data lands and leaves the stale mark standing, an entry with a subscriber or a prefetch holding it fetches once more. `isFetching` stays true between the two requests, and a joined `prefetch` resolves with the fresh data. A page from `fetchNextPage` or `fetchPreviousPage` on a stale entry counts too.

A hydrated row stamped before an invalidation had the same gap. It superseded the refetch the invalidation started and left the entry stale, with nothing fetching. A subscribed entry now fetches once more there as well.
