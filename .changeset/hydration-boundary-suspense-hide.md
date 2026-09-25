---
"@kontsedal/olas-react": patch
---

**A `<Suspense>` above `HydrationBoundary` no longer disposes the app root when it shows its fallback.**

The boundary disposed its root in a layout-effect cleanup. React runs those cleanups when a Suspense boundary hides content it already showed, so a later suspension above the boundary, such as a `useSuspenseQuery` after a key change, disposed the live root, and the fallback stayed up. The dispose is a passive effect again, which a hide leaves alone.

Two smaller changes to the same boundary:

- a root that no commit claims and that never goes idle, such as one with a hung fetch, is disposed after a minute;
- on the server, each render builds its own root. An element hoisted to module scope no longer hands one request's root to the next.
