---
"@kontsedal/olas-core": patch
---

**An effect that ends its controller on resume stops, and primitives disposed early leave the controller.**

A resume re-runs each effect. When that run disposed or suspended the controller, as `ctx.effect(() => { if (session.expired.value) root.dispose() })` does after the session expired during a suspension, the effect kept running. It ran on after the dispose, or inside the suspended tree. The effect now stops with the controller, and after a suspend it re-runs on the next resume. This covers a collection's reconcile and a child an `attach` handle resumes.

A `createCache` cache, a `createMutation` mutation and a `ctx.emitter()` emitter disposed early kept their entry on the controller, and the cache stayed in the root's set for `waitForIdle()`. A controller that churned them, as the Map pattern in SPEC §3.4 does, grew without limit and disposed each one again at its own dispose. Each now drops its entry when it disposes, as a field, form and field array already did.
