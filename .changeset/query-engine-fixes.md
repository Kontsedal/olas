---
"@kontsedal/olas-core": patch
---

**Five query-engine fixes.**

- **A `replace` that discards an invalidation's refetch now catches up.** A reconnect's `invalidateAll()` refetches to reconcile what the app missed. A push folded in with `replace` while that refetch was in flight discarded the response and carried only its own record, so the missed data never arrived and the entry stayed stale with nothing to refetch it. The entry now fetches once more when an invalidation marked it stale and it still has subscribers. A `replace` during that catch-up leaves it in flight, so a burst of pushes cannot keep it from landing. `await invalidate()` resolves when the catch-up settles, and a failed catch-up reaches `onError`.
- **A `retry` or `retryDelay` callback that throws no longer wedges `isFetching`.** The throw escaped the retry loop: the fetch rejected while `status` stayed `'pending'` and `isFetching` stayed `true`, so `waitForIdle()` and `firstValue()` hung. The throw now fails that attempt with the thrown error, for regular and infinite queries and for infinite page requests. The mutation runner was not affected.
- **`ErrorContext.attempt` and `cause` are set.** No call site set them before. A failed fetch an invalidation reports now carries `attempt`, the 0-based attempt that failed last, and `cause`, the fetch error a throwing retry callback replaced.
- **An infinite query's optimistic snapshots rebase on a successful fetch**, as a regular query's do. A rollback after `fetchNextPage` restored the pages from before the fetch and dropped the appended page. It now keeps the page and drops only the optimistic change, after a refetch and `fetchPreviousPage` as well.
- **`host.queries.replace` has one rule for both query kinds.** On an infinite query it cancelled a fetch in flight even for empty pages. Every `replace` path, app-side and plugin, now supersedes only when the write leaves the entry holding data.
