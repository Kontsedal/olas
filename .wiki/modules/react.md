---
name: react
description: "@kontsedal/olas-react — Provider, useRoot/useController, use/useQuery/useSuspenseQuery/useField/useFieldInput/useMutation, KeepAlive, HydrationBoundary, streaming SSR hydrator. Built on useSyncExternalStore."
type: module
covers:
  - packages/react/src/index.ts
  - packages/react/src/context.ts
  - packages/react/src/hooks.ts
  - packages/react/src/keep-alive.ts
  - packages/react/src/streaming.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/react/tests/adapter.test.tsx }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: supersedes, target: ../decisions/no-react-adapter-yet.md }
last_verified: 2026-05-22
confidence: high
---

# `@kontsedal/olas-react`

The React adapter. Pure binding layer on top of `useSyncExternalStore` — no controller construction happens here; React just reads signals. The root is created once outside React (typically in `main.tsx`) and resolved via context. Spec §16, §20.10.

## Public surface

```ts
// context.ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): JSX.Element
function useRoot<Api = unknown>(): Api               // throws outside <OlasProvider>
function useController<Api>(root: Root<Api>): Api    // back-compat — takes root explicitly
function createOlasContext<Api>(displayName?): { Provider, useRoot, use, useQuery, useField, ... }
                                                     // typed-per-root variant; same hooks, narrower context
function HydrationBoundary<Api>(props: { root: Root<Api>; ... }): ReactElement
                                                     // mounts the streaming hydrator (see "Streaming SSR")

// hooks.ts
function use<T>(signal: ReadSignal<T>): T
function use<T, U>(signal: ReadSignal<T>, sel: (v: T) => U, opts?: { isEqual? }): U
                                                     // overload — selector + custom equality
function useQuery<T>(subscription: AsyncState<T>):   { data, error, status, isLoading, isFetching, isStale, lastUpdatedAt, hasPendingMutations, refetch }
function useSuspenseQuery<T>(subscription):          { data, refetch, ... }   // throws the in-flight promise on first read
function useField<T>(field: Field<T>):               { value, errors, isValid, isDirty, touched, isValidating, set, reset, markTouched, revalidate }
function useFieldInput<T>(field: Field<T>, opts?):   { value, onChange, onBlur, ... }  // adapter for native <input>
function useMutation<V, R>(mutation: Mutation<V, R>):{ data, error, isIdle, isPending, isSuccess, isError, run, reset }

// keep-alive.ts
function KeepAlive(props: { controller: SuspendableController; children: ReactNode }): ReactElement
function SuspendOnUnmount(props: { controller: SuspendableController; children: ReactNode }): ReactElement
function useSuspendOnHidden(controller: SuspendableController): void
type SuspendableController = { suspend(): void; resume(): void }

// streaming.ts
function createStreamingHydrator(): StreamingHydrator     // server-side: plugin + flush() for SSR streams
function createStreamingTransform(): TransformStream      // Web-streams sibling of the above
function installStreamingIntake(): void                   // client-side: bootstrap shim for <HydrationBoundary>
const OLAS_BOOTSTRAP_SCRIPT: string                       // drop into bootstrapScriptContent
const STREAMING_GLOBAL: '__OLAS_HYDRATION__'              // intake queue's window key
```

## How subscription works

`useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`:

- `subscribe(onChange)` registers handlers on the underlying olas signals. Returns an unsubscribe.
- `getSnapshot()` returns the current snapshot — React uses `Object.is` to decide whether to re-render.

Olas's `signal.subscribe(handler)` fires the handler **synchronously with the current value** on subscribe (same as `@preact/signals-core`). That initial fire MUST NOT translate into a store-change notification: React already has the initial value via `getSnapshot`, and notifying during the subscribe phase confuses tear-detection.

The fix lives in `subscribeOnChange` (`hooks.ts:11-21`): wrap the handler with a per-subscription `initial` flag and swallow the first fire. This pattern is repeated in `use`, `useQuery`, and `useField` — all three rely on it.

## `useQuery` / `useField` — multi-signal batching

A naive `useQuery` would call `useSyncExternalStore` once per signal in `AsyncState<T>`. That works but means N re-render triggers when several signals change in a `batch()`, and the version-counter shortcut it originally used defeated uSES's tear detection (see below).

The pattern (`hooks.ts`, shared by `useQuery` / `useField` / `useFieldInput` / `useMutation`):

1. A memoized core `computed(() => ({ …read every relevant signal's `.value`… }))`, keyed on the subscription target via `useMemo`. Reading each `.value` inside makes the computed re-evaluate — and mint a NEW plain-values object — exactly when any dep changes, and return the SAME object reference when nothing did.
2. `subscribe(onChange)` = `snapshot.subscribeChanges(onChange)` — one subscription on the computed.
3. `getSnapshot()` = `snapshot.value` — a referentially-stable object that reflects real store state.
4. `const snap = useSyncExternalStore(...)`; the hook returns `snap`'s fields plus the action closures.

The returned methods (`set`, `reset`, `markTouched`, `revalidate` on `useField`; `refetch` on `useQuery`; `mutate`/`reset` on `useMutation`) are passed through with closures so destructuring works without `.bind(...)` on the caller side.

## Why a computed snapshot, not a version counter?

An earlier version used `getSnapshot = () => versionRef.current`, a number bumped only inside the `subscribe` callback. It's referentially stable, but it **defeats uSES's mount-consistency check**: a write landing between render and subscription doesn't bump the counter (the hook isn't subscribed yet), so uSES's re-check compares the same stale number, passes vacuously, and the component shows stale `.peek()`ed values until the next write — initial-mount tearing is undetectable for the same reason (T4.5). The computed's `.value` changes identity exactly when a dep changes, so `getSnapshot` reflects the actual store and the consistency check works. Pinned by `adapter.test.tsx` (R4.5).

## `<OlasProvider>` and StrictMode

The root is constructed by `createRoot(def, { deps })` **outside** React. `OlasProvider` is a plain `Context.Provider`; it doesn't do anything else. So StrictMode's double-mount-and-effect-twice behavior has no effect on the controller tree — the factory ran exactly once, when `createRoot` was called. See `adapter.test.tsx`'s "double-mount does not double-construct" case.

If a sub-controller has UI-driven lifecycle (e.g. hidden routes), the `<KeepAlive>` wrapper handles suspend/resume. StrictMode causes an extra `resume → suspend → resume` cycle which is safe: `ControllerInstance.suspend()` is a no-op when already suspended and `resume()` is a no-op when already active.

## `KeepAlive` and `useSuspendOnHidden`

Default behavior in olas: unmounting the React component does NOT dispose the controller (the controller is owned by its parent and `createRoot`'s consumer). `<KeepAlive>` opts the wrapped sub-tree into a different policy:

- on React (re-)mount → `controller.resume()`
- on React unmount → `controller.suspend()`

**Refcounted across wrappers (T4.6).** A module-level `WeakMap<controller, count>` means `resume()` fires only when the FIRST wrapper on a controller mounts and `suspend()` only when the LAST unmounts. So during a cross-fade — the entering screen mounts while the exiting one is still mounted — the controller stays resumed regardless of effect order, and the exiting screen's unmount can't suspend a controller the entering screen still uses. Uses an isomorphic `useLayoutEffect` so `resume()` runs before the first paint after a remount. Pinned by `keep-alive.test.tsx` (R4.6).

`useSuspendOnHidden` is the same idea keyed off `document.visibilityState` (not refcounted — it's a single per-controller visibility hook). Guards `typeof document !== 'undefined'` so it's safe to import from SSR code (no-op on the server).

## `HydrationBoundary` — root ownership (T4.1)

Unlike `<OlasProvider>` (which takes a root created outside React), `HydrationBoundary` **creates and owns** the root for client-side SSR hydration. `createRoot` is side-effectful (fetches, timers, focus/online listeners), so it must NOT run in `useMemo` / a `useState` initializer — StrictMode re-invokes those and orphans a live root (the original bug). Instead (`context.ts`):

- The root is created **lazily during render** in a `useRef` (`if (rootRef.current === null) …`) — a ref mutated in render creates exactly one root across StrictMode's double render.
- `options` is captured in a ref on first mount and **read once**; a new inline `options={{...}}` on a parent re-render is ignored (it would otherwise discard cache state every render). The root is recreated only when the **`def` identity** changes (dispose old + create new, in render).
- A `useEffect(…, [])` disposes on unmount. StrictMode simulates mount→unmount→remount **without re-rendering between them**, so the effect's remount-setup recreates the disposed root and `forceRender()`s so the Provider hands descendants a live root (a dev-only double-construct, as TanStack does). Pinned by `packages/react/tests/hydration-boundary.test.tsx`.

## Fakes for UI tests

`@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)`. They produce shape-correct objects that satisfy `Field<T>` / `AsyncState<T>` so a test can pass them straight into a `useField`/`useQuery`-consuming component without building a real controller. See `testing.ts:31-132`.
