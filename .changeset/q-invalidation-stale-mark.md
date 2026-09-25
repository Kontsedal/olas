---
"@kontsedal/olas-core": patch
---

**An invalidation is no longer lost to a fetch that started before it.** With no subscribers, `invalidate` only marks an entry stale. A released entry keeps its fetch running for the gc window, and that older response used to clear the mark when it landed, so the next subscriber skipped the refetch. With `staleTime: Infinity` the pre-invalidation data stayed for good. The mark now holds until data requested after it lands: a fetch that started after the invalidation, or a hydrated row stamped after it. Hydration follows the same rule for regular and infinite entries; it used to clear the mark for infinite entries only.
