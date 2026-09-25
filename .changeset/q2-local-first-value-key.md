---
"@kontsedal/olas-core": patch
---

**A local cache's `firstValue()` waits for the new key after a key change.**

With `keepPreviousData`, a `createCache` local cache keeps the previous key's data on screen after its key changes. `firstValue()` resolved with that data at once, so a navigation guard read the wrong record. It now settles with the fetch for the new key, as a shared query's subscription does.
