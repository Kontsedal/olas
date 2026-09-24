---
"@kontsedal/olas-core": minor
"@kontsedal/olas-persist": minor
---

**New first-party plugins, and helpers for testing plugins.**

**persist: `persistQueryCachePlugin`.** It keeps the query cache across reloads. Queries opt in with `meta: { persist: true }`, or an `include` function decides.
- Canonical writes are written to storage, throttled. Optimistic writes and rollbacks are skipped, and a garbage-collected entry leaves storage.
- The stored cache is restored when the root starts. A different `buster`, or an entry older than `maxAgeMs`, is dropped.
- With asynchronous storage (IndexedDB), the restore fills only entries no one has subscribed to yet, and `root.waitForIdle()` waits for it.
- `restoreQueryCache(options)` reads the cache ahead of `createRoot` for `hydrate`, when the first render must see it.
- Infinite queries persist with their page params.

**core `/testing`.**
- `mockFetchPlugin(handlers, options?)` answers query fetches by id: canned data, a function of the attempt, or an error, with latency that honors cancellation. An unmocked query fails its fetch unless `passthrough: true`.
- `createPluginRecorder()` records every plugin observation event, for assertions.

A plugin authoring guide is in `PLUGINS.md`.
