---
"@kontsedal/olas-core": patch
---

**Live hydration skips rows older than the entry, and a future timestamp counts as now.** A streamed or persisted row stamped before an entry's `lastUpdatedAt` reverted newer client data and moved `lastUpdatedAt` back. Such a row is now skipped, and plugins hear no write for it. A payload stamped ahead of the client's clock read `isStale` with `staleTime: 0` yet never refetched, and stayed fresh past `staleTime`. A future stamp is now read as the client's now.
