---
"@kontsedal/olas-entities": patch
---

**`entities.update` patches each query as it is now, and the walk is linear in shared data.**

- **A patch lands where the entity is.** `update` used to write the patch at the paths the last walk recorded. Another plugin can change an entry before this plugin walks it. One earlier in the plugin list reacts to the write first, or one reacting to a backprop write rewrites another entry mid-update. A path that led nowhere dropped the patch silently. A path that something else had taken over got the patch instead. A reorder of `[p1, p2]` to `[p2, p1]` wrote p1's patch over p2. `update` now finds every node `idOf` claims with that id in the entry's current data and replaces it. An entry that no longer holds the entity gets no write, and its binding is dropped.
- **The walk reads the entry as it is now.** On a write, the plugin walks the entry's current data instead of the event's. When an earlier plugin had already written the entry again, walking the older value put stale entities back into the store.
- **A shared object is walked once.** The walker descended into a shared object once per path, so a chain of diamonds with 2^depth paths took 2^depth steps. It now descends into each object once, and the cost is linear in the objects and the references between them. A shared `Post` is still bound at every key that references it. An entity nested inside a shared object is bound at the path the walk first reached it by, so `bindings()` lists fewer paths there. The patch does not depend on the paths, rebuilds a shared object once, and keeps it shared.
- **An updater that returns the stored value writes no query.**
