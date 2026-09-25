---
name: render-phase-root-leak
description: A root built during render and disposed in an effect leaks whenever React discards the render before it commits. A retry must reuse it, and something other than an effect must dispose it.
type: pitfall
covers:
  - packages/react/src/context.ts:177-357
  - packages/react/src/context.ts:411-479
edges:
  - { type: tested-by, target: ../../packages/react/tests/hydration-boundary.test.tsx }
  - { type: uses, target: ../modules/react.md }
  - { type: related, target: ../flows/ssr.md }
last_verified: 2026-09-25
confidence: medium
---

# A root built in render leaks when the render never commits

## The trap

`HydrationBoundary` must build its root during render, because its children read hydrated data in that same render. The pre-fix boundary kept the root in a `useRef` and disposed it in a `useEffect` cleanup. That handled StrictMode's double render, and it looked complete.

React does not promise that a render commits. It discards one when:

- a child suspends before the boundary's first commit, with the nearest `<Suspense>` above the boundary;
- a child throws, and an error boundary above catches it;
- a higher-priority update interrupts a concurrent render;
- the tree unmounts while it is still suspended.

A discarded render runs no effect, so no cleanup disposes its root. A never-committed fiber keeps no hook state either, so the retry starts with an empty ref and builds another root. `createRoot` is side-effectful: fetches, timers, focus and online listeners, plugin setup and controller effects all start at once. Each discarded attempt left one live root behind.

## How bad it was

Measured against the pre-fix boundary under React 19.2:

- Unmounting while suspended: two roots built (React 19 re-renders a suspended tree once to prerender it), none disposed. Their controller effects kept running.
- Suspend, resolve, unmount: three roots built, one disposed.
- `useSuspenseQuery` under a `<Suspense>` above the boundary never loaded. Each retry's new root fetched again, and the child suspended on the new fetch. That made 22 roots and 22 fetches in 200 ms, on the fallback forever.
- A `def` change in a transition that suspended disposed the committed root during render. The committed tree kept rendering on a disposed root.

## The fix

The rules, implemented in `packages/react/src/context.ts`:

1. **A render never disposes and never takes ownership.** Only the commit writes `ownedRef`, claims a root, and disposes the root it replaces.
2. **A retry reuses the root of its earlier attempt.** `acquireRoot` keys unclaimed roots by the props object, which a retry of the same element shares (`context.ts:256-305`). The server builds a root per render instead, because nothing there commits.
3. **Something other than an effect disposes a root that never commits.** `armSweep` disposes a root still unclaimed ten seconds after its work goes idle (`context.ts:313-333`). The countdown waits for idle because a child suspended on the root's own fetch retries only when that fetch settles. A minute bounds that wait, for a root that never goes idle.
4. **A commit that cannot claim its root rebuilds it.** The root may have been swept, claimed by another fiber rendering the same element, or disposed by StrictMode's simulated unmount. The claim effect builds a fresh one and renders again before paint (`context.ts:447-454`).
5. **Dispose on unmount in a passive effect, never a layout effect.** React runs layout-effect cleanups when a `<Suspense>` above hides content it already showed. A layout-effect dispose treated that hide as an unmount and killed the live root. The second review round caught this regression in the first version of the fix.

React gives no signal for a discarded render, so a timer is the only deterministic way to catch one. A `FinalizationRegistry` on the fiber would never dispose too early, but it disposes at an unknown time, and its effects keep running until then.

## What it still costs

An element the parent re-creates on each attempt is a new props object. That happens when the `<Suspense>` sits above the component that renders the boundary. `findReusable` then reuses an unclaimed root built from the same `def`, the same `hydrate` object and `deps` with the same members, so the usual inline `options={{ deps: { api }, queries: queryEngine() }}` no longer loops. The loop remains only when those options change between attempts, such as a `hydrate` parsed inline on every render. A development build warns once then. A `<Suspense>` inside the boundary avoids the question, because the boundary commits first.

A root swept while React still meant to commit it costs a rebuild, and the rebuild refetches whatever `hydrate` did not cover. That needs a child waiting on something outside the root, such as a `lazy()` chunk or a `use()` promise, for longer than the grace period.

## The general rule

Any resource built in render and released in an effect has this leak. The usual fix is to make construction inert and start the work in an effect, as TanStack's `QueryClient` does with `mount()`. An Olas root starts its work in `createRoot`, so the adapter has to track the roots itself.
