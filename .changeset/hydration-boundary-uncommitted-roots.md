---
"@kontsedal/olas-react": patch
---

**`HydrationBoundary` no longer leaks the root of a render that never commits.**

The boundary builds its root during render, so its children can read hydrated data in the first render. Its effects dispose that root. A child that suspended or threw before the boundary's first commit made React discard the render, and no effect ran. The root stayed alive, with its fetches, timers and controller effects, and each retry built another one. A child calling `useSuspenseQuery` under a `<Suspense>` above the boundary never loaded: each retry's new root fetched again and suspended again.

Now:

- a retry of the same element reuses the root its earlier attempt built;
- a root that no commit claims is disposed about ten seconds after its work goes idle;
- a render for a new `def` no longer disposes the committed root, so a transition that suspends keeps the old tree working. The old root is disposed when the new one commits.

A retry of an element that the parent re-created cannot find the earlier root, and builds a new one. Put a `<Suspense>` boundary inside `HydrationBoundary`, around the part that suspends.
