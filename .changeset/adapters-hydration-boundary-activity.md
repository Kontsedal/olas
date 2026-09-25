---
"@kontsedal/olas-react": patch
---

**An `<Activity>` above `HydrationBoundary` no longer throws its root away on hide.**

React 19.2 runs a hidden `<Activity>` subtree's effect cleanups, and runs the effects again when it shows. The boundary disposed its root in that cleanup, so showing the subtree built a second root and lost what the user had typed. React cleans up an unmount the same way, and gives no signal that tells the two apart. The cleanup now suspends the root and disposes it a minute later, unless the boundary's effects run again first. A hide shorter than that keeps the root and its state. After a longer one, the boundary builds a fresh root from `options` when it shows.

An unmount now disposes the root after that minute instead of at once, and the root stays suspended meanwhile. StrictMode's simulated unmount and remount keep one root, suspended and resumed, instead of disposing it and building another.
