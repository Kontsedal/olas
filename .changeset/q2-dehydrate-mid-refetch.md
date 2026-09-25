---
"@kontsedal/olas-core": patch
---

**`dehydrate()` keeps an entry that holds data during a refetch or after a failed one.**

`dehydrate()` serialized only entries at `status: 'success'`. `status` reads `'pending'` over the data during a background refetch, and `'error'` over it after a failed one. A dehydrate at either moment, such as a persisted cache saving on a write, dropped an entry that held data. It now serializes every entry that holds data, stamped with the time that data was written.
