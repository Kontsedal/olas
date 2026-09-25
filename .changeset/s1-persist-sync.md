---
"@kontsedal/olas-persist": patch
---

**persist: the query cache keeps what a session never visited, and cross-tab sync no longer diverges or skips `migrate`.**

- **`persistQueryCachePlugin` with `restore: false` no longer deletes stored entries this session did not bind.** On the documented path, `restoreQueryCache` into `hydrate`, the plugin knew only the entries a query bound, and its first write replaced storage with those. A session that visited only page B dropped page A's entry. The plugin now reads storage at startup whether or not it restores, and with async storage its first write waits for that read.
- **`createPersisted` drops a pending throttled write when another tab's change arrives.** With `throttleMs`, the older local value used to land after the other tab's newer one, and the tabs disagreed from then on.
- **`createPersisted` runs `migrate` on a cross-tab change, as it does on load.** A tab still running an old build could put an old-shaped, unversioned value straight into a versioned signal. The migrated value is not written back, because the old build still reads that key.
