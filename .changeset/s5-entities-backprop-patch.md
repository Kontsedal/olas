---
"@kontsedal/olas-entities": patch
---

**`entities.update` patches each query's own copy, and keeps prototypes.**

- The backprop writes a patch of the entity as each query holds it, which the engine re-runs on each live optimistic baseline. It used to write the store's value into every query, and the store shows a pending guess. A like pending on the feed then reached the detail query and the value the feed's rollback restores, so a failed like stayed everywhere. An updater `patch` now runs once per query and once per live baseline, and must be pure.
- Every object the patch rebuilds keeps its prototype. A class instance a fetcher returned, such as a page wrapper with methods, came back a plain object, and a null-prototype object came back with `Object.prototype`. The same holds for the entity when a shallow or deep merge rebuilds it.
