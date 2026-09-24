---
name: framework-adapters
description: Why Olas ships React, Vue and Svelte adapters (and Preact through `preact/compat`), how each one maps a signal onto its framework, and what the adapter-parity suite proves.
type: decision
covers:
  - packages/react/src/hooks.ts
  - packages/vue/src/index.ts
  - packages/svelte/src/index.ts
  - packages/integration/tests/adapter-parity/scenarios.ts
  - packages/react/tests/preact-compat.test.tsx
  - vitest.config.ts
edges:
  - { type: tested-by, target: ../../packages/integration/tests/adapter-parity/scenarios.ts }
  - { type: tested-by, target: ../../packages/react/tests/preact-compat.test.tsx }
  - { type: uses, target: ../modules/react.md }
  - { type: uses, target: ../modules/vue.md }
  - { type: uses, target: ../modules/svelte.md }
  - { type: related, target: no-vanilla-adapter.md }
last_verified: 2026-09-24
confidence: medium
---

# Three framework adapters

## The decision

Olas 1.0 ships three UI adapters: `@kontsedal/olas-react`, `@kontsedal/olas-vue` and `@kontsedal/olas-svelte`. Preact is supported through `preact/compat` with the React adapter, not with a fourth package. `no-vanilla-adapter.md` records why a second adapter for the same framework family is the wrong shape.

SPEC promise 4 says a UI framework is swapped by swapping a thin adapter. One adapter cannot show that. Three adapters over three different reactivity models can, and the parity suite turns the claim into a test.

## How each adapter maps a signal

Each framework already has a reactive primitive, so each adapter is a translation, not a runtime.

| Adapter | A `ReadSignal<T>` becomes | Re-render granularity |
|---|---|---|
| React | a value read through `useSyncExternalStore` | per field read during render (`useQuery`, `useInfiniteQuery`); per hook elsewhere |
| Vue | a read-only `Ref<T>` from `customRef` | per ref, which Vue tracks on its own |
| Svelte | itself: the signal already satisfies the store contract | per `$store` |

**React** gets its granularity from tracked getters (`hooks.ts`, `useTrackedSnapshot`). The result object records which fields a component reads during render. The subscription then notifies React only when one of those moves. A read after commit returns the live value, so an untracked field does not read stale. Until anything is read, every change notifies, which keeps `renderHook(() => useQuery(sub))` working.

**Vue** needs no tracking of its own. `useQuery` returns one ref per `AsyncState` signal, and Vue's dependency tracking re-renders a template only for the refs it read. The ref's getter reads `signal.peek()`, so a write is visible to the next read at once, before Vue flushes. The subscription ends with the current effect scope (`onScopeDispose`).

**Svelte** needs the least. An Olas signal's `subscribe` calls its handler with the current value at once and returns the unsubscribe. That is Svelte's store contract, so `$count` works on a signal as it is. A `Field` also has `set`, which makes it a writable store for `bind:value`. The package adds `setRoot` and `getRoot` over Svelte context, and one `computed` store per multi-signal object.

## What the parity suite proves

`packages/integration/tests/adapter-parity/` holds one module of scenarios, `scenarios.ts`, and one harness per renderer: React, `preact/compat`, Vue and Svelte. Each harness renders the same markup for a scenario, and `runParity` drives every one of them with the same clicks and keystrokes and asserts the same text. The six scenarios cover a signal, the unsubscribe on unmount, a query, an infinite query, a field with validation, and a fire-and-forget mutation.

A pass shows that each adapter reads the same signals, re-renders on the same writes, passes the same actions through, and lets go of its subscriptions on unmount. It does not show that the adapters render equally fast. Nor does it show that each view is idiomatic for its framework: the Vue views are render functions, so the suite needs no SFC compiler.

The suite was checked for teeth by breaking one adapter's change notification at a time. Each break failed that adapter's runs and left the others green: 5 of 6 for Vue, 4 of 6 for Svelte, and the signal scenario for React and Preact.

## Preact

`packages/react/tests/preact-compat.test.tsx` mocks `react` and its JSX runtimes onto `preact/compat` with `vi.mock`, renders with preact's `render`, and asserts that the mock is live. It pins the three risks the backlog named:
- compat's `useSyncExternalStore` shim still gives the fine-grained `useQuery`;
- compat's `Suspense` retries a suspended `useSuspenseQuery` once the data lands;
- `SuspendOnUnmount` suspends on unmount.

It does not cover `HydrationBoundary`'s StrictMode path, because compat's `StrictMode` does nothing.

## Svelte in the test runner

A Svelte component test needs the compiler plugin and the `browser` resolve condition. Without the condition, `svelte` resolves to its server build and `mount` throws. Adding the condition globally would move other packages to their browser builds too, so the root `vitest.config.ts` runs the Svelte tests as a second project. `vitest.stryker.config.ts` drops the projects, because Stryker runs core's tests only.
