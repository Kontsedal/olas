---
"@kontsedal/olas-core": patch
---

**`firstValue()` resolves at once when the entry holds data.** A background refetch sets `status: 'pending'` over data, and `firstValue()` waited for it instead of resolving with the data on hand, as its documentation says it does. It now resolves at once whenever data is present, a failed background refetch included. A subscription's `refetch()` that a newer fetch supersedes still settles with that newer fetch. The docs no longer claim `status` stays `'success'` during a background refetch: it reads `'pending'` while the data stays.
