---
"@kontsedal/olas-core": patch
---

**`debounced` and `throttled` schedule through the shared expiry scheduler.** Their windows used a raw `setTimeout`, which fires a non-finite delay after about a millisecond and overflows one past the 32-bit limit, so `debounced(source, Infinity)` emitted almost at once. A window of `Infinity` now never fires on its own, and `flush()` still emits. A finite window past the limit waits its full length.
