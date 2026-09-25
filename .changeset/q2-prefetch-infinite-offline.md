---
"@kontsedal/olas-core": patch
---

**An infinite query's `prefetch` requested offline resolves with the first page.**

A fetch requested offline parks until reconnect. For an infinite query, the reconnect drain resolved the parked request with no value, so `prefetch` resolved `undefined`. It now resolves with the first page, as it does online. The `offlineFirst` park gets the same fix.
