---
"@kontsedal/olas-core": patch
---

**A plain `root.suspend()` keeps an armed `maxIdleTime`, and a failed bootstrap tears down in the dispose order.**

A second `suspend()` without `maxIdleTime` cancelled the auto-dispose a first `suspend({ maxIdleTime })` had armed. A visibility hook that suspended an already-suspended root thereby lifted the memory bound. A plain `suspend()` now leaves the timer running, and a `suspend({ maxIdleTime })` still restarts it.

When the root factory threw, `createRoot` disposed the plugins and the query client without closing them first. Plugins heard the rollback's events, such as a query entry deactivating. Delivery now closes before the rollback, as it does in `root.dispose()`.
