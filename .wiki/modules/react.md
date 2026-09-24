---
name: react
description: "@kontsedal/olas-react — Provider, useRoot, useValue/useQuery/useInfiniteQuery/useSuspenseQuery/useField/useFieldInput/useMutation, SuspendOnUnmount, HydrationBoundary, streaming SSR hydrator. Built on useSyncExternalStore; runs under preact/compat."
type: module
covers:
  - packages/react/src/index.ts
  - packages/react/src/context.ts
  - packages/react/src/hooks.ts
  - packages/react/src/keep-alive.ts
  - packages/react/src/streaming.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/react/tests/adapter.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/ssr-hydration.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/keep-alive.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/hooks-surface.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/fine-grained.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/preact-compat.test.tsx }
  - { type: related, target: ../decisions/framework-adapters.md }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: supersedes, target: ../decisions/no-react-adapter-yet.md }
  - { type: related, target: ../decisions/typed-use-root.md }
  - { type: related, target: ../decisions/disabled-subscriptions.md }
last_verified: 2026-09-24
confidence: medium
---

# `@kontsedal/olas-react`

The React adapter. Pure binding layer on top of `useSyncExternalStore` — no controller construction happens here; React only reads signals. The root is created once outside React (typically in `main.tsx`) and resolved via context. Spec §16, §20.10.

## Public surface

```ts
// context.ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode }): JSX.Element
function useRoot<Api = RegisteredApi>(): Api         // root.api, typed by the augmented Register; throws outside <OlasProvider>
function createOlasContext<Api>(displayName?): { Provider, useRoot, Context }
                                                     // typed-per-root variant, for apps with several roots
function HydrationBoundary<Api>(props: { root: Root<Api>; ... }): ReactElement
                                                     // mounts the streaming hydrator (see "Streaming SSR")

// hooks.ts
function useValue<T>(signal: ReadSignal<T>): T      // any ReadSignal: signal, computed, Field, Form, FieldArray
function useValue<T, U>(signal, { select, isEqual? }): U
function useQuery<T>(sub: AsyncState<T>): UseQueryResult<T>
    // every AsyncState signal as a value (incl. isPaused, isEnabled) + refetch, reset, cancel
function useInfiniteQuery<P, I>(sub: InfiniteQuerySubscription<P, I>, opts?): UseInfiniteQueryResult<P, I>
    // useQuery's fields + pages, flat, hasNext/PreviousPage, isFetchingNext/PreviousPage + fetchNextPage, fetchPreviousPage
function useSuspenseQuery<T>(sub): UseSuspenseQueryResult<T>   // throws sub.firstValue() until data lands;
    // a disabled query suspends until enabled + loaded (dev warns) — decisions/disabled-subscriptions.md
function useField<T>(field: Field<T>): UseFieldResult<T>
    // value, errors, isValid, isDirty, touched, isValidating + set, setAsInitial, reset, markTouched, revalidate, setErrors
function useFieldInput<T>(field: Field<T>, opts?): UseFieldInputResult  // spread onto a native <input>
function useMutation<V, R>(m: Mutation<V, R>, callbacks?): UseMutationResult<V, R>
    // data, error, status, isPending, isIdle, isSuccess, isError, lastVariables + mutate (void), run (promise), reset

// keep-alive.ts
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

The fix is core's `subscribeChanges`, which skips that first fire. `useValue` calls it through `subscribeOnChange` (`hooks.ts:24-26`), and the multi-signal hooks call it on their snapshot computed.

## `useQuery` and `useInfiniteQuery` re-render only for what the component reads (1.0)

Both hooks go through `useTrackedSnapshot` and `trackedView` in `hooks.ts`. The returned object has one getter per snapshot field, and a getter read during render adds its field to a tracked set, kept for the component's life. The `subscribeChanges` handler compares the tracked fields of the previous and next snapshot and calls React's `onChange` only when one moved. So `const { data } = useQuery(sub)` does not re-render while a background refetch flips `isFetching`.

Three rules keep it safe:
- **Until anything is read, every change notifies.** A consumer that has read nothing cannot have been shown a stale value, and `renderHook(() => useQuery(sub))` followed by `result.current.data` keeps working.
- **A read after commit is live.** A `rendering` flag is set on each render and cleared in an isomorphic layout effect. A getter read outside render (an event handler, an effect, a test) returns `snapshot.peek()[key]`, not the rendered value, and starts tracking the field.
- **Suspense tracks `data` and `status` itself**, whatever the component reads, because the suspend decision reads them.

Spreading the result (`{ ...useQuery(sub) }`) calls every getter, so it tracks every field. Pinned by `packages/react/tests/fine-grained.test.tsx`; against the pre-1.0 hooks, the tests for the new behaviour fail and the four pinning old behaviour pass.

`useInfiniteQuery` is the same hook over sixteen fields: `useQuery's` ten plus `pages`, `flat` and the four paging flags. It takes `{ suspense: true }` with `useQuery's` rules.

## `useField` / `useMutation` — multi-signal batching

A naive `useQuery` would call `useSyncExternalStore` once per signal in `AsyncState<T>`. That works but means N re-render triggers when several signals change in a `batch()`, and the version-counter shortcut it originally used defeated uSES's tear detection (see below).

The pattern (`hooks.ts`, shared by every multi-signal hook; `useQuery` and `useInfiniteQuery` add the tracked filter above in step 2):

1. A memoized core `computed(() => ({ …read every relevant signal's `.value`… }))`, keyed on the subscription target via `useMemo`. Reading each `.value` inside makes the computed re-evaluate — and mint a NEW plain-values object — exactly when any dep changes, and return the SAME object reference when nothing did.
2. `subscribe(onChange)` = `snapshot.subscribeChanges(onChange)` — one subscription on the computed.
3. `getSnapshot()` = `snapshot.value` — a referentially-stable object that reflects real store state.
4. `const snap = useSyncExternalStore(...)`; the hook returns `snap`'s fields plus the action closures.

The returned actions are closures, so destructuring works without `.bind(...)`. `useField`'s and `useMutation`'s are built in a `useMemo` keyed on the target, so their identity is stable across renders and a memoized child that takes `set` or `mutate` doesn't re-render.

## `useMutation`: `mutate` and `run`

- **`mutate(vars)`** returns nothing. It is the call for an event handler. A failure lands on `error` and `status` and in `onError`; `mutate` swallows the rejection, so it never becomes unhandled.
- **`run(vars)`** returns the run's promise, and the caller owns the rejection. It returns the promise derived from the callbacks, so a caller that ignores a failed `run` gets an unhandled rejection rather than a silent drop.
- **An aborted run fires no callback** (superseded `latest-wins`, `reset()`, or dispose). That matches the mutation's own hooks in core, which skip `onError` and `onSettled` on abort. Before 1.0 the React `onError` fired with the `AbortError`.

Pinned by `packages/react/tests/hooks-surface.test.tsx`.

## Why a computed snapshot, not a version counter?

An earlier version used `getSnapshot = () => versionRef.current`, a number bumped only inside the `subscribe` callback. It is referentially stable, but it **defeats uSES's mount-consistency check**. A write landing between render and subscription does not bump the counter, because the hook is not subscribed yet. uSES's re-check then compares the same stale number, passes vacuously, and the component shows stale `.peek()`ed values until the next write. Initial-mount tearing is undetectable for the same reason (T4.5). The computed's `.value` changes identity exactly when a dep changes, so `getSnapshot` reflects the actual store and the consistency check works. Pinned by `adapter.test.tsx` (R4.5).

## `<OlasProvider>` and StrictMode

The root is constructed by `createRoot(def, { deps })` **outside** React. `OlasProvider` is a plain `Context.Provider`; it doesn't do anything else. So StrictMode's double-mount-and-effect-twice behavior has no effect on the controller tree — the factory ran exactly once, when `createRoot` was called. See `adapter.test.tsx`'s "double-mount does not double-construct" case.

If a sub-controller has UI-driven lifecycle (e.g. hidden routes), the `<SuspendOnUnmount>` wrapper handles suspend/resume. StrictMode causes an extra `resume → suspend → resume` cycle which is safe: `ControllerInstance.suspend()` is a no-op when already suspended and `resume()` is a no-op when already active.

## `SuspendOnUnmount` and `useSuspendOnHidden`

Default behavior in olas: unmounting the React component does NOT dispose the controller (the controller is owned by its parent and `createRoot`'s consumer). `<SuspendOnUnmount>` opts the wrapped sub-tree into a different policy:

- on React (re-)mount → `controller.resume()`
- on React unmount → `controller.suspend()`

**Refcounted across wrappers (T4.6).** A module-level `WeakMap<controller, count>` means `resume()` fires only when the FIRST wrapper on a controller mounts, and `suspend()` only when the LAST unmounts. During a cross-fade the entering screen mounts while the exiting one is still mounted. The controller therefore stays resumed regardless of effect order, and the exiting screen's unmount cannot suspend a controller the entering screen still uses. Uses an isomorphic `useLayoutEffect` so `resume()` runs before the first paint after a remount. Pinned by `keep-alive.test.tsx` (R4.6).

`useSuspendOnHidden` is the same idea keyed off `document.visibilityState` (not refcounted — it's a single per-controller visibility hook). Guards `typeof document !== 'undefined'` so it's safe to import from SSR code (no-op on the server).

**It undoes itself on cleanup (0.9 review).** The effect tracks whether the standing suspension is its own doing, and resumes on the way out if it is. Unmounting a subtree while the tab was hidden used to strand the controller: the hook had suspended it, and the `visibilitychange` listener that would have resumed it went with the same cleanup. Swapping the `controller` argument while hidden stranded the outgoing one the same way. A controller the hook never suspended is left alone, which keeps the existing "don't resume a visible tab on mount" rule intact. Three cases in `keep-alive.test.tsx`.

## `HydrationBoundary` — root ownership (T4.1)

`<OlasProvider>` takes a root created outside React. `HydrationBoundary` instead **creates and owns** the root for client-side SSR hydration. `createRoot` is side-effectful, starting fetches, timers and focus and online listeners, so it must NOT run in a `useMemo` or a `useState` initializer. StrictMode re-invokes those and orphans a live root, which was the original bug. `context.ts` does this instead:

- The root is created **lazily during render** in a `useRef` (`if (rootRef.current === null) …`) — a ref mutated in render creates exactly one root across StrictMode's double render.
- `options` is captured in a ref on first mount and **read once**; a new inline `options={{...}}` on a parent re-render is ignored (it would otherwise discard cache state every render). The root is recreated only when the **`def` identity** changes (dispose old + create new, in render).
- A `useEffect(…, [])` disposes on unmount. StrictMode simulates mount, unmount and remount **without re-rendering between them**. The effect's remount-setup therefore recreates the disposed root and calls `forceRender()`, so the Provider hands descendants a live root. This is a dev-only double-construct, as TanStack does. Pinned by `packages/react/tests/hydration-boundary.test.tsx`.

## SSR round trip, end to end (0.9 review)

`packages/react/tests/ssr-hydration.test.tsx` is the only test that puts `renderToString` and `hydrateRoot` on the same markup. Server: build a root, `waitForIdle`, render to a string, `dehydrate`. Client: build a root with `{ hydrate: state }`, hydrate over that HTML, and assert `onRecoverableError` was never called — React funnels a hydration mismatch there before discarding the server's DOM. A second case, hydrating the same HTML against a root whose query never settles, asserts the check has teeth by watching it fire.

Everything else covers one half: `hydration-boundary.test.tsx` covers the boundary's lifecycle, `packages/core/tests/ssr.test.ts` covers dehydrate/hydrate, and `examples/reader-ssr/tests/ssr.test.ts` covers the cache hit without React.

## Preact, through `preact/compat` (1.0)

The adapter imports only hooks, `createContext` and three types from `react`, and never imports `react-dom`, so a Preact app aliases `react` to `preact/compat` and uses this package as it is. `packages/react/tests/preact-compat.test.tsx` mocks `react` and both JSX runtimes onto compat, renders with preact's `render`, and asserts the mock is live before anything else. It covers the provider, `useValue`, the fine-grained `useQuery` under compat's `useSyncExternalStore` shim, `useInfiniteQuery`, `useSuspenseQuery` under compat's `Suspense`, `useFieldInput`, `useMutation` and `SuspendOnUnmount`. `HydrationBoundary`'s StrictMode path is not covered: compat's `StrictMode` does nothing. The parity suite runs Preact as a fourth renderer too (`decisions/framework-adapters.md`).

## Fakes for UI tests

`@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)`. They produce shape-correct objects that satisfy `Field<T>` or `AsyncState<T>` so a test can pass them straight into a `useField`/`useQuery`-consuming component without building a real controller. See `testing.ts:31-132`.

## Streaming SSR security (1.0)

`createStreamingTransform` writes a batch only where the HTML so far sits between elements. `HtmlBoundary` in `streaming.ts` tracks the markup it passes through. The old transform wrote a `<script>` after every chunk, and React's fixed-size chunks can end inside an attribute value, which was an XSS (`pitfalls/stream-chunks-split-tags.md`).

Each batch's payload is `serializeForScript` from core: `JSON.parse("…")` over a fully escaped string. So an own `__proto__` key stays data on the client, and no quote, angle bracket or line separator reaches the script raw. `createStreamingHydrator({ nonce })` puts a CSP nonce on each tag. The bootstrap and each batch check that `self.__OLAS_HYDRATION__` is the intake, so a page element with that id cannot clobber it. Pinned by `tests/streaming-security.test.tsx`; the rest is in `decisions/trust-model.md`.
