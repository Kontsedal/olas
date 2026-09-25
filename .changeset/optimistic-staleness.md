---
"@kontsedal/olas-core": patch
---

**An optimistic write no longer makes stale data look fresh.**

An optimistic `setData` moved `lastUpdatedAt`, and the subscribe-time staleness check read it. Past `staleTime`, a new subscriber then skipped its refetch while the write was live, after it rolled back, and after it was finalized. After a rollback it showed old server data as fresh. The `isStale` signal read `true` all along, so the signal and the refetch decision disagreed.

Staleness now counts from the last fetch, hydrated row or canonical `write` or `replace`, for regular and infinite queries. A subscriber, `resume()`, focus or reconnect refetch or `prefetch` that finds the entry stale while an optimistic write is live starts no fetch, since the response would land over the guess. The entry runs that fetch once the last live write settles, if something still holds it. The decision waits one microtask, so an `invalidate()` in `onSuccess` or `onSettled` makes the only request. `lastUpdatedAt` still moves on an optimistic write. `isStale` now restarts its timer on a canonical write and on an infinite query's page fetch, which the refetch decision already counted as fresh.
