---
"@kontsedal/olas-react": patch
---

**`HydrationBoundary` no longer refetches forever when its parent re-creates it below an outer `<Suspense>`.**

A retry of a discarded render found its root by the element's props object. A component below an outer `<Suspense>` that renders the boundary with inline options creates a new element on every retry, so each retry built a new root, refetched what the child suspended on, and suspended again. A retry now also reuses an unclaimed root built from the same `def`, the same `hydrate` object and `deps` with the same members. When those options change between attempts, the retry still builds a new root, and a development build warns once, naming the fix.
