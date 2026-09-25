---
"@kontsedal/olas-core": minor
---

**`createCache` gains the canonical writes, and `waitForIdle()` counts it.**

- `LocalCache` has `write(updater)` and `replace(value)`, with `Query`'s semantics. `write` patches without a snapshot and leaves a fetch in flight alone. `replace` sets the whole record and supersedes a fetch in flight. Before, a canonical patch to a local cache was `setData(…).finalize()`, and a forgotten `finalize()` left `hasPendingMutations` true for good.
- `root.waitForIdle()` waits for `createCache` fetches, on a root with or without a query engine. SSR code no longer needs to await `cache.firstValue()` for each local cache.
