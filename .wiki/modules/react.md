---
name: react
description: "@olas/react — Provider, useRoot, use/useQuery/useField, KeepAlive, useSuspendOnHidden. Built on useSyncExternalStore."
type: module
covers:
  - packages/react/src/index.ts
  - packages/react/src/context.ts
  - packages/react/src/hooks.ts
  - packages/react/src/keep-alive.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/react/tests/adapter.test.tsx }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: supersedes, target: ../decisions/no-react-adapter-yet.md }
last_verified: 2026-05-18
confidence: high
---

# `@olas/react`

The React adapter. Pure binding layer on top of `useSyncExternalStore` — no controller construction happens here; React just reads signals. The root is created once outside React (typically in `main.tsx`) and resolved via context. Spec §16, §20.10.

## Public surface

```ts
// context.ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): JSX.Element
function useRoot<Api = unknown>(): Api               // throws outside <OlasProvider>
function useController<Api>(root: Root<Api>): Api     // back-compat — takes root explicitly

// hooks.ts
function use<T>(signal: ReadSignal<T>): T
function useQuery<T>(subscription: AsyncState<T>): { data, error, status, isLoading, isFetching, isStale, lastUpdatedAt, hasPendingMutations, refetch }
function useField<T>(field: Field<T>): { value, errors, isValid, isDirty, touched, isValidating, set, reset, markTouched, revalidate }

// keep-alive.ts
function KeepAlive(props: { controller: SuspendableController; children: ReactNode }): ReactElement
function useSuspendOnHidden(controller: SuspendableController): void
type SuspendableController = { suspend(): void; resume(): void }
```

## How subscription works

`useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`:

- `subscribe(onChange)` registers handlers on the underlying olas signals. Returns an unsubscribe.
- `getSnapshot()` returns the current snapshot — React uses `Object.is` to decide whether to re-render.

Olas's `signal.subscribe(handler)` fires the handler **synchronously with the current value** on subscribe (same as `@preact/signals-core`). That initial fire MUST NOT translate into a store-change notification: React already has the initial value via `getSnapshot`, and notifying during the subscribe phase confuses tear-detection.

The fix lives in `subscribeOnChange` (`hooks.ts:11-21`): wrap the handler with a per-subscription `initial` flag and swallow the first fire. This pattern is repeated in `use`, `useQuery`, and `useField` — all three rely on it.

## `useQuery` / `useField` — multi-signal batching

A naive `useQuery` would call `useSyncExternalStore` eight times (once per signal in `AsyncState<T>`). That works but means 8 re-render triggers when several signals change in a `batch()`.

The pattern (`hooks.ts:46-95` for `useQuery`, `hooks.ts:101-149` for `useField`):

1. One `useRef<number>` counter per hook instance — bumped whenever ANY subscribed signal fires.
2. One `useSyncExternalStore` subscribe that fans out into N inner `subscribeOnChange` calls. Each fires `versionRef.current++; onChange()`.
3. `getSnapshot()` returns `versionRef.current` — a number. Identical across renders when nothing changed; bumped exactly once per actual change cycle (preact batches synchronous writes).
4. After the hook returns, read each signal via `.peek()` (untracked) to build the plain-values object.

The returned methods (`set`, `reset`, `markTouched`, `revalidate` on `useField`; `refetch` on `useQuery`) are passed through with closures so destructuring `const { set } = useField(field)` works without `.bind(field)` on the caller side.

## Why a counter and not the snapshot object?

`getSnapshot` must return a referentially stable value when nothing changed (React uses `Object.is`). Returning a fresh `{ data, error, ... }` object each render would cause infinite re-renders. The counter avoids the trap: it only changes when a real subscription fired, so React's bail-out works.

## `<OlasProvider>` and StrictMode

The root is constructed by `createRoot(def, { deps })` **outside** React. `OlasProvider` is a plain `Context.Provider`; it doesn't do anything else. So StrictMode's double-mount-and-effect-twice behavior has no effect on the controller tree — the factory ran exactly once, when `createRoot` was called. See `adapter.test.tsx`'s "double-mount does not double-construct" case.

If a sub-controller has UI-driven lifecycle (e.g. hidden routes), the `<KeepAlive>` wrapper handles suspend/resume. StrictMode causes an extra `resume → suspend → resume` cycle which is safe: `ControllerInstance.suspend()` is a no-op when already suspended and `resume()` is a no-op when already active.

## `KeepAlive` and `useSuspendOnHidden`

Default behavior in olas: unmounting the React component does NOT dispose the controller (the controller is owned by its parent and `createRoot`'s consumer). `<KeepAlive>` opts the wrapped sub-tree into a different policy:

- on React unmount → `controller.suspend()`
- on React (re-)mount → `controller.resume()`

`useSuspendOnHidden` is the same idea keyed off `document.visibilityState`. Guards `typeof document !== 'undefined'` so it's safe to import from SSR code (no-op on the server).

## Fakes for UI tests

`@olas/core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)`. They produce shape-correct objects that satisfy `Field<T>` / `AsyncState<T>` so a test can pass them straight into a `useField`/`useQuery`-consuming component without building a real controller. See `testing.ts:31-132`.
