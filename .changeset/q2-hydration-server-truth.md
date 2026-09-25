---
"@kontsedal/olas-core": patch
---

**Live hydration compares a row against the server data, not against an optimistic write.**

`root.hydrate` skipped a row stamped before the entry's `lastUpdatedAt`, which an optimistic `setData` also moves. A newer server row was then dropped after an optimistic write and its rollback, and during a pending mutation. The row is now compared against the time of the entry's last fetch, hydrated row or canonical write. A row that arrives during an optimistic write becomes the rollback baseline, as a fetch result does.

A row for a key nothing has bound waits in a buffer. The buffer took every row as it came, so an older row replaced a newer one and the first bind showed the older data. It now keeps the newest row per key.
