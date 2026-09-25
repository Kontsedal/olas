---
"@kontsedal/olas-core": patch
---

**An infinite refetch starts from the first loaded page, and paging during the first load joins it.**

A refetch started at `initialPageParam`, so a list paged backwards to `[-2, -1, 0]` came back as `[0, 1, 2]`. It now starts at the first loaded page's param and walks forward, as TanStack does, hydrated and persisted entries included. Pages written into an entry with no params take `initialPageParam` as their param, not `undefined`. `fetchNextPage()` or `fetchPreviousPage()` before a page has loaded aborted the first load and started it again, one request per call; they now join the load in flight.
