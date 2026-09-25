---
name: react
description: "@kontsedal/olas-react — OlasProvider, useRoot (root.api, typed by Register), useValue, useQuery, useInfiniteQuery, useSuspenseQuery, useField, useFieldInput, useMutation, SuspendOnUnmount, HydrationBoundary, and the streaming SSR hydrator plugin. Built on useSyncExternalStore; runs under preact/compat."
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
  - { type: tested-by, target: ../../packages/react/tests/hydration-boundary.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/streaming.test.tsx }
  - { type: related, target: ../decisions/framework-adapters.md }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: uses, target: ../flows/use-root.md }
  - { type: uses, target: ../flows/ssr.md }
  - { type: related, target: ../pitfalls/render-phase-root-leak.md }
  - { type: supersedes, target: ../decisions/no-react-adapter-yet.md }
  - { type: related, target: ../decisions/typed-use-root.md }
  - { type: related, target: ../decisions/root-handle-separate.md }
  - { type: related, target: ../decisions/disabled-subscriptions.md }
last_verified: 2026-09-25
confidence: high
---

# `@kontsedal/olas-react`

The React adapter. Pure binding layer on top of `useSyncExternalStore` — no controller construction happens here; React only reads signals. The root is created once outside React (typically in `main.tsx`) and resolved via context, and `useRoot()` returns its `root.api`. Spec §16, §20.10.

## Public surface

```ts nocheck
// context.ts
function OlasProvider(props: { root: Root<unknown>; children: ReactNode })
function useRoot<Api = RegisteredApi>(): Api         // root.api, typed by the augmented Register; throws outside <OlasProvider>
interface Register {}                                // the app augments it with { root: typeof root }
function createOlasContext<Api>(displayName?): OlasContext<Api>   // { Provider, useRoot, Context }
                                                     // typed-per-root variant, for apps with several roots
function HydrationBoundary<Api>(props: { def: ControllerDef<void, Api>; options: RootOptions<…>;
                                         streaming?: boolean; children: ReactNode }): ReactNode
                                                     // creates and owns the root; installs the streaming intake

// hooks.ts
function useValue<T>(signal: ReadSignal<T>, { isEqual? }?): T   // any ReadSignal: signal, computed, Field, Form, FieldArray
function useValue<T, U>(signal, { select, isEqual? }): U
function useQuery<T>(sub: AsyncState<T>, { suspense? }?): UseQueryResult<T>
    // every AsyncState signal as a value (incl. isPaused, isEnabled) + refetch, reset, cancel
function useInfiniteQuery<P, I>(sub: InfiniteQuerySubscription<P, I>, { suspense? }?): UseInfiniteQueryResult<P, I>
    // useQuery's fields + pages, flat, hasNext/PreviousPage, isFetchingNext/PreviousPage + fetchNextPage, fetchPreviousPage
function useSuspenseQuery<T>(sub): UseSuspenseQueryResult<T>   // useQuery(sub, { suspense: true }); throws sub.firstValue()
    // until data lands; a disabled query suspends until enabled + loaded (dev warns) — decisions/disabled-subscriptions.md
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
function createStreamingHydrator({ nonce? }?): StreamingHydrator  // server: { plugin, flush, dispose }
function createStreamingTransform(flush: () => string): TransformStream<Uint8Array, Uint8Array>
function installStreamingIntake<Api>(root: Root<Api>): () => void // client: connect a root to the streamed batches
const OLAS_BOOTSTRAP_SCRIPT: string                       // drop into bootstrapScriptContent
const STREAMING_GLOBAL: '__OLAS_HYDRATION__'              // intake queue's window key
```

The listing matches `packages/react/src/index.ts:1-47`. `useRoot` is at `context.ts:81-87` and `HydrationBoundary` at `context.ts:332-398`.

## How subscription works

`useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`:

- `subscribe(onChange)` registers handlers on the underlying olas signals. Returns an unsubscribe.
- `getSnapshot()` returns the current snapshot — React uses `Object.is` to decide whether to re-render.

Olas's `signal.subscribe(handler)` fires the handler **synchronously with the current value** on subscribe (same as `@preact/signals-core`). That initial fire MUST NOT translate into a store-change notification: React already has the initial value via `getSnapshot`, and notifying during the subscribe phase confuses tear-detection.

The fix is core's `subscribeChanges`, which skips that first fire. `useValue` calls it through `subscribeOnChange` (`hooks.ts:37-39`), and the multi-signal hooks call it on their snapshot computed.

## `useQuery` and `useInfiniteQuery` re-render only for what the component reads (1.0)

Both hooks go through `useTrackedSnapshot` and `trackedView` in `hooks.ts`. The returned object has one getter per snapshot field, and a getter read during render adds its field to a tracked set, kept for the component's life. The `subscribeChanges` handler compares the tracked fields of the previous and next snapshot and calls React's `onChange` only when one moved. So `const { data } = useQuery(sub)` does not re-render while a background refetch flips `isFetching`.

Three rules keep it safe:
- **Until anything is read, every change notifies.** A consumer that has read nothing cannot have been shown a stale value, and `renderHook(() => useQuery(sub))` followed by `result.current.data` keeps working.
- **A read after commit is live.** An isomorphic layout effect counts the component's commits in `state.commits`, and each render keeps the count it saw as `renderedAt` (`hooks.ts:197`). A getter reads the rendered snapshot while the two match, which covers the render itself and a child reading the result in the same pass. Once this component commits again, a getter returns `snapshot.peek()[key]` and starts tracking the field (`hooks.ts:226-229`, `read`). That covers an event handler, an effect, a test, and a stale closure over an older result.
- **Suspense tracks `data` and `status` itself**, whatever the component reads, because the suspend decision reads them.

Spreading the result (`{ ...useQuery(sub) }`) calls every getter, so it tracks every field. Pinned by `packages/react/tests/fine-grained.test.tsx`; against the pre-1.0 hooks, the tests for the new behaviour fail and the four pinning old behaviour pass.

**Why a counter and not a flag (2026-09-25 review).** The first version set a `rendering` flag on each render and cleared it in the layout effect. A render React throws away runs no effect, as when a transition's sibling suspends. The flag stayed set, and the committed result's getters kept returning its rendered snapshot, so a field the component never read in render was read stale. A counter only moves on a commit, so a discarded render cannot hold it. This is a cousin of `../pitfalls/render-phase-root-leak.md`: state that a render sets and only a commit resets. Pinned by "a read after commit stays live when a later render is thrown away".

`useInfiniteQuery` is the same hook over sixteen fields: `useQuery`'s ten plus `pages`, `flat` and the four paging flags. It takes `{ suspense: true }` with `useQuery`'s rules.

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

**Refcounted across wrappers (T4.6).** A module-level `WeakMap<controller, Reasons>` counts the mounted wrappers in `held`, so `resume()` fires only when the FIRST wrapper on a controller mounts, and `suspend()` only when the LAST unmounts. During a cross-fade the entering screen mounts while the exiting one is still mounted. The controller therefore stays resumed regardless of effect order, and the exiting screen's unmount cannot suspend a controller the entering screen still uses. Uses an isomorphic `useLayoutEffect` so `resume()` runs before the first paint after a remount. Pinned by `keep-alive.test.tsx` (R4.6).

`useSuspendOnHidden` is the same idea keyed off `document.visibilityState`. Guards `typeof document !== 'undefined'` so it's safe to import from SSR code (no-op on the server).

**One record of reasons per controller (2026-09-25 review).** `reasonsFor` (`keep-alive.ts:31-38`) returns `{ held, released, hidden }`, shared by both helpers. `released` is set when the last wrapper unmounts and cleared when one mounts. `hidden` counts the hooks holding the controller suspended for a hidden tab. Each reason calls `suspend()` as it starts, and `resume()` runs only when none is left: a wrapper's first mount resumes only with `hidden` at zero, and a hook lets go with a resume only when `hidden` reaches zero and `released` is unset. Before, the two kept separate books. Unmounting a wrapped subtree on a hidden tab ran the wrapper's layout cleanup, which suspended, and then the hook's passive cleanup, which resumed. The unmounted screen's controller was left running. The end state no longer depends on which cleanup runs first. Pinned by the three cases in "SuspendOnUnmount with useSuspendOnHidden on the same controller".

**It undoes itself on cleanup (0.9 review).** The effect tracks whether it holds the controller suspended (`suspendedHere`), and lets go on the way out if it does. Unmounting a subtree while the tab was hidden used to strand the controller: the hook had suspended it, and the `visibilitychange` listener that would have resumed it went with the same cleanup. Swapping the `controller` argument while hidden stranded the outgoing one the same way. A controller the hook never suspended is left alone, which keeps the existing "don't resume a visible tab on mount" rule intact. Three cases in `keep-alive.test.tsx`.

## `HydrationBoundary` — root ownership (T4.1)

`<OlasProvider>` takes a root created outside React. `HydrationBoundary` instead **creates and owns** the root for client-side SSR hydration. The children read hydrated data in the boundary's first render, so the root must exist during that render. `createRoot` is side-effectful, starting fetches, timers, focus and online listeners and controller effects. A render may never commit, so building the root there needs the bookkeeping below. `../pitfalls/render-phase-root-leak.md` has the bug this replaced.

- **Render acquires, commit claims.** A render with no committed root for its `def` calls `acquireRoot` (`context.ts:213-235`). It returns the unclaimed root an earlier attempt of the same element built, found in `uncommittedByProps` by the props object, or builds one and records it in `uncommitted`. The first layout effect calls `claimRoot`, which takes the root out of both maps, and stores it in `ownedRef` (`context.ts:368-375`). A render reads `ownedRef`, and only the commit writes it.
- **Why the props object.** A retry of a discarded render reuses the element, and so the props object. A retry that built a new root refetched whatever the child suspended on, and the child suspended again, forever. An element the parent re-created is a new props object, so its retry builds a new root. The TSDoc tells apps to put a `<Suspense>` inside the boundary.
- **The sweep.** `armSweep` disposes a root that stays unclaimed for `ORPHAN_GRACE_MS` (ten seconds) after `root.waitForIdle()` resolves (`context.ts:243-259`). The countdown starts at idle because a child suspended on the root's own fetch is retried when that fetch settles, and the retry must still find the root. Each reuse restarts the countdown. The server keeps no strong reference and arms no timer, since nothing commits there.
- **A failed claim rebuilds.** `claimRoot` returns `false` when the root is gone: the sweep disposed it, another fiber rendering the same element claimed it first, or StrictMode's simulated unmount disposed it. The effect then builds a fresh root from the same `def` and options and calls `forceRender()`, before paint. StrictMode always takes this path, because it runs unmount and remount without a render between them. The rebuilt root reuses the same options, and so the same `queryEngine()` value, which works because an engine is a definition. Pinned by "(b2) StrictMode with a query engine and a hydrate payload" and "(k) one element rendered twice gets two independent roots".
- **Unmount disposes, in its own effect.** A second layout effect with `[]` deps disposes the owned root on unmount. The claim effect has no cleanup, because a cleanup there would also run when `root` changes.
- `options` is captured in a ref on first mount and **read once**; a new inline `options={{...}}` on a parent re-render is ignored (it would otherwise discard cache state every render).
- **A new `def` never disposes in render.** The render acquires a root for the new `def` with `hydrate` dropped from the owned root's options (`context.ts:358`). The server payload described the first root's tree, so the replacement starts from its own fetches. A StrictMode remount of the same `def` still hydrates. The claim effect disposes the old root when the new one commits. A transition that suspends therefore keeps the committed tree on a live root. Pinned by "(e) the root rebuilt for a new def does not re-apply the first hydrate payload" and "(j) a new def whose render is thrown away leaves the committed root alive".
- A passive effect calls `installStreamingIntake` on the owned root, unless `streaming={false}` (`context.ts:389-395`). It reads `ownedRef`, so a rebuilt root gets the intake. See `../flows/ssr.md`.
- **Rendered on the server, the boundary leaks its root.** A server render runs no effects, so the cleanup that disposes the root never runs. In a development build the boundary warns once per process, through `warnServerBoundary`, when it renders with no `window` (`context.ts:166-175`, `context.ts:334`). The message names the fix: a per-request root through `OlasProvider`, disposed after the response. The once-gate is a module flag, because the mistake sits in the app's server entry and one message names it. Pinned by `coverage-server-env.test.tsx`, "warns once that its root is never disposed", and the jsdom lifecycle test asserts the browser path stays quiet.

The tests for renders that never commit are the "HydrationBoundary renders that never commit" block of `packages/react/tests/hydration-boundary.test.tsx`. Cases (f) to (j) fail against the pre-fix boundary. (k) passes there, and guards the props-keyed reuse against two fibers sharing a root.

## SSR round trip, end to end (0.9 review)

`packages/react/tests/ssr-hydration.test.tsx` is the only test that puts `renderToString` and `hydrateRoot` on the same markup. Server: build a root, `waitForIdle`, render to a string, `dehydrate`. Client: build a root with `{ hydrate: state }`, hydrate over that HTML, and assert `onRecoverableError` was never called — React funnels a hydration mismatch there before discarding the server's DOM. A second case, hydrating the same HTML against a root whose query never settles, asserts the check has teeth by watching it fire.

Everything else covers one half: `hydration-boundary.test.tsx` covers the boundary's lifecycle, `packages/core/tests/ssr.test.ts` covers dehydrate/hydrate, and `examples/reader-ssr/tests/ssr.test.ts` covers the cache hit without React.

## Preact, through `preact/compat` (1.0)

The adapter imports only hooks, `createContext` and three types from `react`, and never imports `react-dom`, so a Preact app aliases `react` to `preact/compat` and uses this package as it is. `packages/react/tests/preact-compat.test.tsx` mocks `react` and both JSX runtimes onto compat, renders with preact's `render`, and asserts the mock is live before anything else. It covers the provider, `useValue`, the fine-grained `useQuery` under compat's `useSyncExternalStore` shim, `useInfiniteQuery`, `useSuspenseQuery` under compat's `Suspense`, `useFieldInput`, `useMutation` and `SuspendOnUnmount`. `HydrationBoundary`'s StrictMode path is not covered: compat's `StrictMode` does nothing. The parity suite runs Preact as a fourth renderer too (`decisions/framework-adapters.md`).

## Fakes for UI tests

`@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)`. They produce shape-correct objects that satisfy `Field<T>` or `AsyncState<T>`, so a test can pass them straight into a component that calls `useField` or `useQuery` without building a real controller. See `packages/core/src/testing.ts:68-245`.

## Streaming SSR

The server half is a plugin. `createStreamingHydrator` returns `{ plugin, flush, dispose }`, and the plugin's `onWrite` captures the committed writes of the root it is installed in, meaning sources `'fetch'`, `'write'` and `'replace'` (`streaming.ts:126-194`). It skips `'hydrate'`, `'optimistic'` and `'rollback'`. `createStreamingTransform(flush)` places the batches in React's HTML stream. On the client, `installStreamingIntake(root)` applies every batch through `root.hydrate(state)`, one signal `batch` per arriving batch, to every installed root (`streaming.ts:389-451`). The whole flow is `../flows/ssr.md`.

## Streaming SSR security (1.0)

`createStreamingTransform` writes a batch only where the HTML so far sits between elements. `HtmlBoundary` in `streaming.ts` tracks the markup it passes through. The old transform wrote a `<script>` after every chunk, and React's fixed-size chunks can end inside an attribute value, which was an XSS (`pitfalls/stream-chunks-split-tags.md`).

Each batch's payload is `serializeForScript` from core: `JSON.parse("…")` over a fully escaped string. So an own `__proto__` key stays data on the client, and no quote, angle bracket or line separator reaches the script raw. `createStreamingHydrator({ nonce })` puts a CSP nonce on each tag. The bootstrap and each batch check that `self.__OLAS_HYDRATION__` is the intake, so a page element with that id cannot clobber it. Pinned by `tests/streaming-security.test.tsx`; the rest is in `decisions/trust-model.md`.
