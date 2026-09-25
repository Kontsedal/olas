---
"@kontsedal/olas-core": minor
"@kontsedal/olas-devtools": minor
---

**The devtools see who subscribes to each cache entry.**

- **core.** A `createQuery` subscription sends `cache:subscribed` when it binds an entry and the new `cache:unsubscribed` when it lets go, on subscribe, key change, disable, suspend, resume and dispose. Both carry `queryId`, `queryKey` and the subscribing controller's path. `DebugCacheEntry` gains `subscribers`, the count of subscriptions holding the entry, which `root.debug.queryEntries()` always sets. `cache:subscribed` was declared before and never sent.
- **core.** A plugin's `host.queries.invalidate` sends `cache:invalidated`, as an app's `invalidate` does, so a plugin's invalidation shows on the timeline.
- **devtools.** `DevtoolsStore.subscribers$` counts the subscriptions per entry from those events, re-seeded from each `queryEntries()` snapshot so a panel attached late counts them too. The inspector shows the count on each entry, and the cache log renders `unsubscribed` rows.
