---
"@kontsedal/olas-core": patch
---

**`dehydrate()` ships server truth, stamped when the server said it.**

Each row was stamped with `lastUpdatedAt`, which an optimistic write moves and its rollback leaves, so data fetched at 1000 shipped stamped 5000 after a guess and its rollback. The stamp is now the entry's last fetch, hydrated row or canonical write. Under a live optimistic write the row carries the data beneath the guess, so a guess never ships as server truth. A hydrated row whose data is `undefined` now reads `status: 'success'` on the buffered path, as it did on a bound entry. It used to read `'pending'` and refetch despite `staleTime`.
