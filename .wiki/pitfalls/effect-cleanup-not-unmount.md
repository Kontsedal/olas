---
name: effect-cleanup-not-unmount
description: React runs a component's effect cleanups on an unmount, on an <Activity> hide and in StrictMode's replay, with no way to tell them apart; a resource an effect cleanup disposes is lost on a hide. HydrationBoundary suspends its root there and disposes it a minute later.
type: pitfall
covers:
  - packages/react/src/context.ts:186-192
  - packages/react/src/context.ts:428-467
  - packages/react/src/context.ts:563-600
edges:
  - { type: tested-by, target: ../../packages/react/tests/hydration-boundary.test.tsx }
  - { type: related, target: render-phase-root-leak.md }
  - { type: uses, target: ../modules/react.md }
last_verified: 2026-09-25
confidence: medium
---

# An effect cleanup is not an unmount

## The trap

"Dispose in the effect cleanup" reads as "dispose on unmount". React runs the same cleanups in three other cases:
- **`<Activity mode="hidden">`** (React 19.2) runs the hidden subtree's layout and passive effect cleanups, keeps its state, and runs the effects again when it shows.
- **StrictMode** runs every effect's cleanup and then the effect again, once, after the first commit.
- **A `<Suspense>` above** that hides content it already showed runs the layout-effect cleanups only.

A cleanup gets no argument that says which case it is in. `HydrationBoundary` disposed its root in a passive cleanup, so a hidden `<Activity>` above it lost the root. Showing the subtree built a second one, and what the user had typed was gone. The review measured `constructs: 2, disposes: 1`. StrictMode took the same path, which the boundary papered over by rebuilding the root in the claim effect.

## The fix

The boundary cannot tell a hide from an unmount when the cleanup runs, so it waits to see whether the effect comes back:
1. The passive cleanup calls `releaseOwned` (`context.ts:443-452`). It suspends the root, so its effects, polling and refetches stop, and arms a timer for `RELEASE_GRACE_MS`, a minute.
2. The same effect's next run calls `reclaimOwned`. That cancels the timer and resumes the root. StrictMode's replay and an `<Activity>` show both come through here.
3. When the timer fires, the root is disposed and marked `expired`. A real unmount ends here.
4. A show after the timer fired finds the root expired in the claim layout effect. The boundary builds a fresh root from its `options` and renders again before paint, so the tree never reads a disposed root.

The release stays in a passive effect. The layout-effect cleanups run for a `<Suspense>` hide too, and that hide keeps the root running, as before (`render-phase-root-leak.md`, rule 5).

## What it costs

An unmount no longer disposes at once. The root lives on for a minute, suspended. Its query cache, its plugins and their transports stay open until then, so a keyed remount has two roots for that minute, one of them suspended. A hide longer than a minute loses the root, and showing the subtree builds a fresh one, refetches and starts its fields over. The grace period is a fixed constant. An app that keeps an `<Activity>` hidden for long should build its root outside React and hand it to `<OlasProvider>`, which disposes nothing.

React offers no deterministic signal for the difference. A `FinalizationRegistry` on the fiber's state would tell a deleted fiber from a hidden one, but only at garbage-collection time, which may never come.

## The general rule

A resource owned by a component outlives its effects when React keeps the component's state. Stop its work in the cleanup, and release it only once the component is gone for good. TanStack's `QueryClientProvider` has the same shape: `mount()` in the effect, `unmount()` in the cleanup, and the client itself left to garbage collection.

Pinned by `hydration-boundary.test.tsx`: "(a) unmount suspends the root, and disposes it once the grace period ends", and the "HydrationBoundary under <Activity>" block, where a hide keeps the root and the typed value and a hide past the grace period builds a fresh root.
