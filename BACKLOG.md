# BACKLOG

The grab-bag for future work, ideas-in-progress, and post-v1 proposals.

**This is the only place such items live.** They do not live in `SPEC.md`, the design contract for what *is*. They do not live in `CLAUDE.md`, which is operating instructions. They do not live in `.wiki/`, which describes the codebase as it stands. When you notice anything during work — a follow-up, a stray thought, "we should also…", "this would be cleaner if…" — append it here.

## How to use this file

- **Status tags** at the start of each item's heading:
  - `[idea]` — sketch, not committed to.
  - `[planned]` — agreed on, not started.
  - `[in-progress]` — actively being worked.
  - `[dropped]` — explicitly decided against; the reasoning matters.
- **Shipped items are removed.** Once an item lands in the code, delete the entry — the wiki and CHANGELOGs are the durable trail. Dropped items stay (tagged `[dropped]`) because the reasoning matters next time the idea resurfaces.
- **One heading per item.** A short body — context, constraints, what would change, where it'd land. If it grows large, link out to a wiki page or a draft RFC.

## Conventions

- Group by area (Packages, Storage, Devtools, Forms, …). Pure-idea items can live under "Loose ends" until they earn a category.
- Cite `SPEC.md §X.Y` when an item amends the spec; that signals "spec change required, not only an implementation."
- If a backlog item is implied by an existing spec line, quote the line.

---

## Packages

### [planned] A superseded catch-up refetch is discarded, not re-run

`query.replace(...)` supersedes an in-flight fetch (SPEC §5.5, §6.4). `write` has not done so since 0.7.2. Sometimes that fetch is a **catch-up**: a reconnect's `invalidateAll()`, whose whole purpose is to reconcile whatever was missed while disconnected. Discarding it loses the reconciliation, and the write that superseded it carries only its own delta. Nothing re-runs it: `forcedStale` is cleared only by `applySuccess`, `refetchOnWindowFocus` defaults to `false`, and an already-subscribed reader never re-acquires. Worse, `await invalidateAll()` **resolves** (`invalidateEntry` swallows the AbortError), so a caller that treats resolution as "synced" cannot detect it.

Reachable by composing two of this library's own documented recipes: the realtime package's reconnect resync and §6.4's fold-a-buffered-event write.

Shape to aim at: after discarding a response *because a canonical write superseded it*, re-fetch once — but only when the entry was force-stale and still has subscribers, and coalesced so a burst of pushes cannot hold one request in a cancel/restart loop. Plain "supersede without aborting" is not an answer: the result is still discarded.

Deferred out of the change that introduced it because it needs a scheduling policy, not a guard.


### [idea] `@kontsedal/olas-offline` — offline-first reconnection layer atop the mutation queue

`@kontsedal/olas-mutation-queue` (shipped 0.0.5) covers durable enqueue + reload-replay for `defineMutation({ persist: true })`. The remaining offline layer would add navigator-online detection, a connection-state signal, conflict-resolution helpers, an exponential-backoff schedule for inter-attempt waits, and an opinionated mid-session retry policy. Today the queue only retries across page loads. Likely a thin package layered on top of `mutation-queue` + `@kontsedal/olas-persist`.

### [planned] Verify `@kontsedal/olas-react` under `preact/compat`

The adapter imports only `createContext`, `useContext`, `useCallback`, `useMemo`, `useRef`, `useSyncExternalStore`, `useEffect` and `useLayoutEffect`, plus three types, and never imports `react-dom` (`streaming.ts` names `renderToPipeableStream` only in doc comments; its exports are a bootstrap string and a `TransformStream`). Every one of those is in `preact/compat`, so preact support is likely an aliasing exercise rather than a package.

Three things to verify before claiming it: `useSyncExternalStore` in compat is a shim, so the mount-consistency path `.wiki/modules/react.md` documents may not be exercised the same way; `useSuspenseQuery` throws `subscription.promise()` and preact's Suspense retry semantics differ from React's; and compat's `StrictMode` is a no-op, so `HydrationBoundary`'s double-construct handling never fires. Shape of the work: a second vitest project running `packages/react/tests/**` under a `preact/compat` alias, then either widen the peer range and document the setup or document which hooks do not survive.

This replaces the `@kontsedal/olas-preact` package idea. A second adapter is the wrong shape when the first one already compiles against compat. See `.wiki/decisions/no-vanilla-adapter.md`.

### [idea] Framework-agnostic `bindField(el, field, opts)`

The one piece worth salvaging from the dropped vanilla adapter. 156 lines covering what no framework supplies and what `useFieldInput` only covers in a React props-spread shape:

- Save and restore `selectionStart`/`selectionEnd` around a write-back that **differs** from the control's value. A field with a transform or a normalizing setter hits that on every keystroke, and an equality check alone does not cover it.
- Suppress commits in both directions during an IME composition, and **replay a suppressed model write** at `compositionend` rather than discarding it and then overwriting the model with the stale buffer.
- Route by element kind: `checked` for checkbox, per-element value matching for radio, `valueAsNumber` for `type=number`, selected options for `<select multiple>`.
- `transform` parity with `useFieldInput`, plus `blur` calling `markTouched()` and `aria-invalid` from `touched && errors.length`.

Would live in `@kontsedal/olas-core` or alongside the React adapter, taking a real `Element` and returning a disposer. Reference implementation and its tests are recoverable from this session's history if picked up.

### [idea] Cross-adapter parity test — React and preact, one controller tree

Demonstrates SPEC promise 4 ("swap frameworks by swapping a thin adapter") as a test rather than a claim: one controller tree, one set of DOM assertions, two renderers. A version of this existed briefly against React and the dropped vanilla adapter. Pointed at React and `preact/compat` it is better evidence, because both are real frameworks. Depends on the preact verification item above.

Two things such a test must not overclaim: importing React at module level means it shows the *mount path* is framework-free, not the dependency graph; and rows binding a plain string prove less than rows whose content updates.

### [idea] `@kontsedal/olas-vue` — Vue adapter

Signal/ref interop. Out of scope for v1; the architecture is framework-neutral, so it's additive.

### [idea] `@kontsedal/olas-svelte` — Svelte adapter

Signal-as-store. Same scoping as Vue.

### [idea] `@kontsedal/olas-eslint-plugin` — lint rules that catch correctness issues we can't enforce at the type level

Examples:

- fetcher and `mutate` body must use the `signal` parameter.
- Controller factory must not be `async`.
- Do not import `@kontsedal/olas-core/testing` outside test files.

### [idea] `@kontsedal/olas-vite-plugin` — HMR automation

[from SPEC §16.5] Today's recommended HMR shape is "full root rebuild on hot update" (`root.dispose()` then `createRoot(...)` again, ~10 lines of Vite plugin glue). A first-party plugin would automate this.

### [idea] Devtools browser extension

[SPEC §14] An out-of-page extension that consumes `root.__debug.subscribe(...)` — controller tree inspector, cache timeline, mutation log, signal dependency graph, subscription view. The in-app `@kontsedal/olas-devtools` panel already covers the same surfaces; the extension would make them available without instrumenting the page.

### [planned] `dist` retains the forms subsystem, costing half the tree-shaking win

The ctx split made `createRoot` stop statically reaching forms and the query engine. Against `src/` a controllers-only bundle is 4.8 KB gzipped, down from 20.1. Against the published `dist/` it is **8.1 KB**, down from 19.9 — the `QueryClient` exclusion survives the build, the forms exclusion does not.

Cause: `tsdown` flattens the package into one shared chunk, so exclusion inside it depends on statement-level dead-code elimination rather than module-level. `FormImpl` and `FieldArrayImpl` declare their brand markers as computed class-field keys (`readonly [FORM_BRAND] = true`, `forms/form.ts:121` and `:787`), and esbuild will not drop a class with a computed field key even when nothing references it. Verified: a signals-only bundle built from `dist/index.mjs` still contains `olas.form`.

Three ways out, cheapest first: assign the brands inside the constructor instead of as computed field keys; add pure annotations; or configure tsdown to preserve module structure in the output. The first is a two-line change and should be measured before the others are considered.

`sideEffects: false` does not help — it works at module granularity and the chunk is used.

Also retained unconditionally in every bundle: the top-level `globalRegistry(Symbol.for('olas.queryRegistry'))` writes in `query/plugin.ts`. Small, but the same class of problem.

Worth doing before 1.0, because the published numbers are the ones consumers will quote back.

### [idea] `useQuery` re-renders on every `isFetching` flip

[from the 0.9 review] `useQuery` snapshots all eight signals on an `AsyncState`, so a component that reads only `data` still re-renders when a background refetch starts and again when it ends. TanStack answers this with `select` (derive and compare) and `notifyOnChangeProps` (subscribe to a subset). Two related findings in the same hook: the `isEqual` short-circuit is gated on selector identity (`packages/react/src/hooks.ts:90`), so an inline selector — the common case — never reaches it; and `useSuspenseQuery` throws a fresh promise per suspended render (`hooks.ts:208` with `packages/core/src/query/use.ts:123-130`), with the `!cur` path throwing an already-rejected one.

### [idea] No `useInfiniteQuery`

[from the 0.9 review] `defineInfiniteQuery` exists in core, and the React adapter has no hook for it. `examples/kanban/src/features/archive/ArchiveDrawer.tsx` hand-rolls five separate `use(...)` subscriptions to cover what one hook should return. That example is the evidence for the shape the hook needs.

### [idea] Four smaller defects in the React adapter

[from the 0.9 review]

- `packages/react/src/context.ts:160-163` disposes a live root during render when `def` identity changes, and the replacement root reuses the original `options.hydrate` — so the new root hydrates from the old root's server state.
- The streaming intake teardown clobbers a second boundary (`packages/react/src/streaming.ts:281-288`).
- `useField` and `useMutation.reset` return unmemoized action closures, so every consumer of a memoized child re-renders.
- `packages/react/package.json` declares a top-level `"types": "./dist/index.d.cts"` next to `"module": "./dist/index.mjs"`. A bundler that falls back to the top-level `types` gets CJS declarations for an ESM entry.

### [idea] `useFieldInput` and `createOlasContext` have no consumers

[from the 0.9 review] Neither is used by any example or test. An export nobody calls is an export nobody has checked. Either give each one an example and a test, or deprecate it. `useFieldInput` is the more defensible of the two — it is the accessible-input shape — and the four examples all hand-roll `value`/`onChange`/`onBlur` instead, which is itself the argument for wiring one of them through it.

### [idea] Three gaps in `@kontsedal/olas-realtime`

[from the 0.9 review] `channel` is a plain string, not a signal, so a controller cannot express a per-route room without tearing down and rebuilding the subscription. `onReconnect` opens a second transport subscription rather than reusing the first. And `rafFlush`, `onDrop` and the capacity `RangeError` have no tests.

### [idea] Three known costs and silent no-ops in `@kontsedal/olas-entities`

[from the 0.9 review]

- The shared-reference re-walk is exponential in a pathological diamond, while the cost comment on `walk` in `packages/entities/src/index.ts` claims it is linear in reachable nodes.
- `setAtPath` no-ops on a stale path, so a patch aimed at a moved node vanishes.
- One test in `packages/entities/tests/entities.test.ts` ("reverse index drops bindings…") is vacuous, and its title contradicts the contract it claims to pin.

### [idea] Two costs in `@kontsedal/olas-zod`

[from the 0.9 review] `rootOnlyZodValidator` re-parses the whole schema on every validation, on top of the per-leaf validators that already ran. And `warnDuplicateZod` has no once-gate, so a duplicate zod copy warns on every leaf the walker visits.

## Storage / sync

### [idea] Cross-tab sync for infinite queries

[from T6.4] `@kontsedal/olas-cross-tab` and core's remote-apply paths, `applyRemoteSetData` and `applyRemoteInvalidate`, only handle regular `'query'` defs. Infinite queries early-return, so their page arrays cannot be applied cross-tab. The `crossTab: 'infinite'` and `'both'` option values were removed (they broadcast noise no peer could apply). Real support needs a receive path that reconstructs an infinite entry's page array + params (heavier payload, and the receiving tab may have a different page count and cursor), plus a size guard since page arrays can be large. Until then, cross-tab infinite lists should refetch (`invalidate`) rather than sync.

### [idea] Cross-`mutationId` causal ordering in the mutation queue

[from T6.2] `@kontsedal/olas-mutation-queue` replays entries serially **within** a `mutationId` (sorted by `seq`), but different `mutationId`s replay in parallel and cross-tab order isn't coordinated. So a logical dependency like `order/cancel` needing to land after `order/create` (distinct ids) isn't guaranteed on replay. A full fix needs a cross-id dependency DAG (or a global replay sequence with per-entry `dependsOn` edges) plus cross-tab agreement on that order — significant design. Today's guidance: model dependent steps under one `mutationId`, or make the server tolerant of out-of-order arrival (idempotency + reconciliation). Documented as a limitation in the package README.

### [idea] The mutation queue replays a 422 until `maxAttempts`

[from the 0.9 review] `@kontsedal/olas-mutation-queue` treats every replay failure as transient. A 422, a 400 or a 409 that will never succeed burns all `maxAttempts` — with `backoffMs` set, over several page loads — before `onReplayError` fires. Shape: an `isRetryable(err, entry)` option, defaulting to today's "everything is", that drops an entry on the first non-retryable failure and reports it. The awkward part is the contract: `mutate` is a consumer function returning whatever it likes, so the queue cannot read a status code without the consumer handing it one.

### [idea] Two mutation-queue replay paths have no tests

[from the 0.9 review] `packages/mutation-queue/tests/plugin.test.ts` drives a synchronous in-memory adapter in a Node environment, so two paths never execute: the `pendingWrites` ordering that exists for an async adapter (`indexedDbAdapter`, where a `delete` can overtake its own `write`), and the Web Locks branch of `withReplayLock` (Node has no `navigator.locks`, so every test takes the uncoordinated fallback). Both are the parts most likely to break. Needs a promise-returning fake adapter with controllable resolution order, and a fake `navigator.locks` that can grant or refuse.

### [idea] The mutation queue's `seqCounter` can collide across tabs

[from the 0.9 review] `seqCounter` is seeded from `Date.now()` (`packages/mutation-queue/src/plugin.ts`), so two tabs that open in the same millisecond start from the same number and mint the same `seq` for unrelated entries. Replay then orders those entries arbitrarily within a `mutationId`. The `replayAll` priming loop raises the counter past anything already on disk, which narrows the window to entries enqueued before either tab has listed storage. A per-tab random suffix, or a `(seq, tabId)` composite sort key, would close it.

### [idea] Cross-tab sync is last-message-wins with no causality

[from the 0.9 review] `@kontsedal/olas-cross-tab` applies whatever arrives, in arrival order, with no version vector and no conflict resolution. Two tabs editing the same entry converge on whichever message landed last, which need not be the last write. Three related gaps found alongside it:

- An optimistic write broadcast under `source: 'set'` reaches a peer that has no knowledge of the mutation behind it. If the origin tab crashes before its rollback or commit, the peer holds optimistic state forever.
- A peer silently skips an entry that is not currently bound (`packages/core/src/query/client.ts:851-855`), so a tab drops updates for data it has cached but nobody is subscribed to.
- The plugin-reuse-across-roots guard throws from `init`, but `callPlugin` catches it and routes it to `onError`. The half-installed plugin stays attached to the second root. `@kontsedal/olas-entities` has the same shape at `packages/entities/src/index.ts:651-659`.

Each of the four could be a separate change; they share one question, which is what guarantee the transport is supposed to give.

### [idea] Three sharp edges in `@kontsedal/olas-persist`

[from the 0.9 review]

- **Version skew.** A peer running `version: undefined` hands the raw versioned envelope to `deserialize` (`packages/persist/src/index.ts:404-405`), so a tab on the old build parses `{"v":2,"d":"…"}` as the value.
- **`skipFirstDelivery` assumes an immediately-emitting source** (`index.ts:597-601`). A source that does not emit on subscribe has its first real change swallowed instead.
- **`throttleMs` is documented as a debounce and implemented as a trailing throttle** (`index.ts:66-70` against `580-592`). Pick one — the implementation is the safer behavior under a stream of writes, so the doc is probably what should move.

## Forms

### [idea] Path-typed `form.fieldAt('a.b.c')` lookup

[from SPEC §20.7] The current public API uses the nested `form.fields.a.fields.b.fields.c` access. A `fieldAt<P extends FormPath<S>>(path: P): FieldAt<S, P>` would be ergonomic for deep forms but needs template-literal-type machinery that's implementation-heavy. Nested access covers ~95% of cases today, so this is opportunistic, not blocking.

### [idea] Route `formFromZod` root `.refine({ path })` issues onto fields

[noticed during T5.2] Core's `validator()` now returns `FormIssue[]` with paths, and form-level validators route them onto fields. But `formFromZod` still lifts root refines via `rootOnlyZodValidator`, which keeps only **empty-path** issues — so `z.object({...}).refine(fn, { path: ['confirm'] })` is dropped rather than landing on `confirm`. Routing them means distinguishing "root refine targeting a field" from a leaf-schema failure at the same path (leaf validators already own the latter), else the message double-reports. Options: filter root issues to `code: 'custom'` refinements and return them as `FormIssue[]`, or drop per-leaf `zodValidator`s and drive everything from one whole-form `validator(schema)` (bigger change — affects per-leaf `validateOn` and async semantics). Needs its own tests.

## Queries / data layer

### [idea] `useQuery({ suspense: true })` on a disabled query suspends forever

A disabled query, meaning `enabled: () => false`, is `status: 'idle'` with no data. A suspense hook therefore throws `subscription.promise()` and stays suspended indefinitely, and the fallback never resolves. T4.7 tried throwing a descriptive error instead, but an idle-with-no-data subscription is **indistinguishable from one torn down during `root.dispose()`** (both detach → idle), so the hard throw fired during teardown (false positives) and — thrown in render — React 19 re-reports it to node's `uncaughtException`, failing the vitest run. A clean fix needs a way to tell "intentionally disabled" from "transiently idle": e.g. surface an `enabled`/`disabled` flag on the subscription, or a dedicated `status: 'disabled'`. Until then, don't combine `suspense` with a disabled query; gate the whole subtree instead (`{condition && <SuspenseView/>}`).

### [idea] `peek` / `write` for infinite queries

`Query` gained `peek`, a synchronous non-creating read per §5.5, and `write`, a canonical no-snapshot patch per §6.4. `InfiniteQuery` has neither, so the leak `write` fixes is still reachable there. A fire-and-forget `infiniteQuery.setData(...)` leaves a live snapshot per call, and folding a server push into a page array is exactly the shape the realtime recipe uses. The plumbing exists on both sides — `InfiniteEntry.setData` already takes `{ track: false }` and `setEntryData` already routes infinite writes through it — so this is mostly `peekPages` and `writePages` on the client plus two handle methods. Open question worth settling first: `peek` on an infinite query should probably return the **pages array** (`TPage[] | undefined`, matching what `setData`'s updater sees) rather than the flattened `items`, but the flattened form is what most callers want to read.

### [idea] `subscription.refetch()` rejects when the subscription is detached

`SubscriptionImpl.refetch` rejects with `new Error('[olas] no active subscription')` when there is no bound entry — i.e. whenever `enabled` is false (§5.7's detach). Consumers wiring a "Retry" button to `refetch()` therefore need a `.catch(() => {})` on every call site whose `enabled` can be false. That exists purely to silence a rejection carrying no information, and one real app has four of them. Options: resolve to `undefined` instead (breaks the `Promise<T>` return type — a major), expose `isAttached` on `AsyncState` so callers can branch, or keep the rejection and export the sentinel as a named error so it can be filtered rather than blanket-caught. Not obviously worth an API change; recorded because the `.catch()` noise reads like carelessness at the call sites and it isn't.

### [dropped] A React hook that creates a query subscription (`useQuery(query, { key })`)

Requested implicitly by every consumer that has a React **context or hook** needing server data with no controller of its own (theme provider, feature-flag gate, keybinding overrides). `useQuery(subscription)` can only read a subscription a controller made; there is no `useQuery(query, { key })` that mints one.

Dropped on purpose. A component that creates a cache subscription owns data lifetime, which is precisely what §1 moves out of the view. The escape hatch would also be reached for far beyond the provider case, because it is strictly less typing than routing a read through a controller. The supported answer is the **reads-factory** pattern (`RECIPES.md`): a controller owns the subscriptions, exposes them as an object, React reads them by identity via `useRoot()` + `useQuery(sub)`. If this resurfaces, the thing to reconsider is whether the *recipe* is discoverable enough, not whether the hook should exist.

### [idea] Full updater-replay rebasing for concurrent optimistic rollback

[from SPEC §6.4] Rollback today is snapshot-based with **chain-splice** ordering (T3.1). Each `Snapshot` captures a baseline value. Rolling back the top restores it. Rolling back a non-top layer threads its baseline down the chain, so rolling every layer back returns to the pre-mutation value. What it does **not** do: re-run the surviving layers' updater functions against a new baseline. So when A(+1) and B(+10) both apply and A fails first, the visible value stays 11 (both deltas) until B settles, rather than dropping to 10 (B's delta alone). True rebasing would store the updater fns (not only the pre-value), and on any rollback replay the still-live updaters in order over the current server/base value. Cost: `setData` must keep the updater closure alive for the snapshot's lifetime, and replay must be pure/idempotent. Worth it only if the "stale delta on screen until unwind" behavior bites a real app; `concurrency: 'serial'` sidesteps it for conflicting writes today.

### [idea] Rebase infinite-query optimistic snapshots on page-fetch success

[from SPEC §6.4] T3.4 rebases live optimistic snapshots onto fresh server truth in `Entry.applySuccess`, so a rollback after an intervening fetch restores server data, not a pre-fetch baseline. `InfiniteEntry` does **not** do this: its success paths (initial refetch, `fetchNextPage`, `fetchPreviousPage`) don't touch live snapshots' captured `prev`/`prevParams`. So an optimistic `setData` on an infinite query, followed by a successful page fetch and then a rollback, restores the pre-fetch pages (dropping an appended page). Rare (infinite + optimistic + concurrent fetch) and the rebase semantics for a paginated append are non-obvious (rebase `prev` to the *current* pages array?), so deferred. `query.cancel(...)` already lets callers avoid the race for infinite queries too.

### [idea] `offlineFirst` park for infinite queries

[from SPEC §5.5] T3.5 implemented the `offlineFirst` network-error park in `Entry.runWithRetry`, which waits for reconnect and then retries. `InfiniteEntry.runFetch` does not. An `offlineFirst` infinite query that hits a network error while offline still surfaces the error rather than parking. `InfiniteEntry.isPaused` is wired for the `online`-mode offline-defer path only. Adding the park to `runFetch` needs per-direction handling (initial/next/prev) and interacts with the collapse-to-page-one behavior (T3.7). Deferred until infinite offline support is a real requirement.

### [idea] Dehydrate/hydrate infinite queries for SSR

[from SPEC §15] `dehydrate()` skips infinite entries, because `client.ts` walks only `client.maps` and not `infiniteMaps`. A server-rendered infinite list therefore refetches its currently-loaded pages on the client after hydration (T3.7 part 2). Adding it needs: serialize `pages` + `pageParams` per infinite entry (heavier than a single-value payload), a `DehydratedInfiniteEntry` shape, hydration wiring in `bindInfiniteEntry` (seed `pages`/`pageParams`/status like `Entry`'s `initialData` path), and the streaming hydrator (`packages/react/src/streaming.ts:114`) to carry the page arrays. Deferred: the first-page refetch-on-client is acceptable for now, and page-array payloads bloat the SSR document. Documented as a limitation in SPEC §15 and the react README.

### [dropped] Next.js app-router / RSC support

Next.js is misaligned with olas's philosophy: the controller-tree model assumes a client-driven, signal-reactive runtime where lifecycle, dispose, and `createQuery` keying live in user space. RSC inverts that — the server owns rendering, components are render functions of props, and the framework dictates data-fetching boundaries. Bolting olas onto that model leads to one of two bad outcomes. It makes olas a thin pass-through to whatever Next.js already does, which defeats the point. Or it requires a parallel server-side controller runtime, doubling the surface area for an audience already well served by TanStack Query and `'use server'` actions.

**We don't need Next.js.** Olas is for logic-heavy client-driven apps (Linear/Notion class) where the controller tree carries real weight. Pages-router SSR via `dehydrate`/`hydrate` (already shipped, spec §11) covers the SSR case for the apps that benefit from it. RSC consumers should reach for the framework's native data-fetching story.

Keep this entry as a reference: future contributors will ask "why not Next?" and the answer needs to be findable.

## Controllers

### [idea] `root.replaceController(path, newDef)` — in-place HMR-friendly swap

[from SPEC §16.5] Surgically replace one controller while preserving siblings and cache subscriptions. Significant complexity (subscription rebinding, prop reconciliation). The current recommended HMR shape (full root rebuild) sidesteps this; revisit only if rebuild ergonomics turn out to be a real friction point.

## Devtools

The flagship **devtools overhaul** (causal-timeline debugger) is partially landed: T8.1
(event backbone — `seq`/`t`/`causeId`, `cache:set-data`, `snapshot:*`, ambient-cause
threading, event-driven inspector) and T8.4 (the causal Timeline tab + structural diffs)
shipped 2026-07-28. The remaining phases live in
`.wiki/candidates/decisions/devtools-overhaul.md` (T8.2 virtualize + ring buffer, T8.3
omnibox, T8.5 subscription/effect tracing, T8.6 live actions, T8.7 env sim + forms
inspector, T8.8 plugin lanes, T8.9 session traces, T8.10 UX pass). The small T8.1
leftovers below are terse enough to live here.

### [idea] Wire `cache:subscribed` / `cache:unsubscribed`

The `cache:subscribed` variant is declared in the `DebugEvent` union but never emitted —
it needs the subscriber's controller path threaded through `createQuery` → `ClientEntry.acquire`
(and a matching `cache:unsubscribed` on `release` 1→0). Feeds per-entry subscriber counts
in the inspector and "who's watching this" in the timeline. Part of overhaul T8.5.

### [idea] Devtools events for infinite queries

T8.1 wired `cache:fetch-*` + `snapshot:*` only for regular queries — `InfiniteEntry` has
no `EntryEvents` hooks, so infinite fetches/optimistic writes don't appear on the timeline
(only `setInfiniteData` emits `cache:set-data`). Add the same hook bundle to `InfiniteEntry`
(per-direction: initial, next and prev) and wire it in `InfiniteClientEntry`.

### [idea] Timeline group ordering by most-recent activity

`groupByCause` positions a cause-group at its FIRST event's `seq`, so a long-running group
whose latest event is recent still sorts low (newest-first is by group start, not last
activity). Fine for the common single-mutation case; revisit if multi-cause interleaving
gets confusing — order groups by their last event's `seq` instead.

## Documentation / polish

### [in-progress] Inline TSDoc on all exported types

The major exports carry one-line descriptions (e.g. `defineQuery`, `defineController`, `useField`). What's still missing: `@example` blocks attached to public surfaces and TSDoc on the long tail of utility exports. Going through each package's `index.ts` re-exports systematically and adding one `@example` per primitive would materially improve IDE hover. Worth doing alongside the next API.md sweep.

## Examples

### [idea] Extract the example UI *components* into `examples/_shared/ui/`

The **tokens** are now shared: `examples/_shared/ui/tokens.css` holds the type roles, the three
corner tiers, the control ladder, space, motion and the solved palette, and all four examples
import it. See [`.wiki/decisions/ui-rules.md`](.wiki/decisions/ui-rules.md).

What is still per-app is the **components**. Kanban has Button, Input, Select, Tag, Badge, Avatar,
Toast, Dialog and the rest in `examples/kanban/src/ui/`, written as plain CSS classes; the other
three are Tailwind utility strings inline. Sharing components across those two idioms is the part
that was never the easy half, and stock-ticker has no React at all. Worth doing only if a fifth
example turns up wanting the same primitives — three call sites is not yet a component library.

### [idea] virtualized-table example lacks a controller test

The other three examples (kanban, reader-ssr, stock-ticker) each ship a `tests/` suite driving their controller via `createTestController` with no DOM. `examples/virtualized-table` has none — yet the root README's examples section implies every example is covered ("Every business-logic surface in these examples is covered by a controller test"). Either add a `tests/controller.test.ts` for `tableController` (row upsert, per-row optimistic edit + `onError` rollback, `selection` range + bulk-apply, title filter) — a natural fit since it's the "rows are data" showcase — or soften the README claim. Adding the test is the better close: the controller is pure and already DOM-free.

### [idea] kanban's `isPaused` is written but never read

[from the 0.9 review] `examples/kanban/src/features/card-detail/card-detail.controller.ts` sets an `isPaused` signal from `suspend`/`resume` and nothing renders it. The example's stated point is that a `<SuspendOnUnmount>` wrapper's effect is visible, so either surface the signal in the panel or drop it.

## Tooling / DX

### [idea] Local `pnpm lint` fails on Windows (CRLF vs biome `lineEnding: "lf"`)

`biome.json` sets `formatter.lineEnding: "lf"` but the repo has no `.gitattributes`, so with `core.autocrlf=true` (the default on the maintainer's Windows box) every source file is CRLF in the working tree and `biome check .` reports "Formatter would have printed…" for *every* file. CI passes only because Linux checks out LF. Fix options: add `.gitattributes` (`* text=auto eol=lf`) so checkouts are LF, then `git add --renormalize .` once; or set `core.autocrlf=input` locally. Deferred because renormalizing mid-remediation would bury the real diffs in line-ending noise. Local rule-checking meanwhile is `pnpm exec biome lint .` (skips the formatter); CI verifies formatting.

### [idea] Three biome rules are off, and the examples are why

[from the 0.9 review] `biome.json` disables `useHookAtTopLevel`, `useExhaustiveDependencies` and `noArrayIndexKey`. The review found one real instance of two of them in the examples — a conditional return above seven hooks, and an index key on a list with a delete — both since fixed. The rules were off, so nothing caught them. Re-enabling all three repo-wide would flag existing code in the packages too; the narrower move is to enable them for `examples/**` only, where the code is meant to be exemplary, and to record here what the package-level exceptions would be.

### [idea] Satellite/integration packages typecheck against built `dist`, not `src`

`tsconfig.base.json` has no `paths`. So `@kontsedal/olas-*` imports in the satellite packages, such as react, persist and entities, and in the integration suite, resolve to each package's built `dist/*.d.ts` via `exports.types`. Consequences: (1) `pnpm typecheck` needs a prior `pnpm build` or it sees stale/absent types — and **CI runs `typecheck` BEFORE `build`**, so a fresh checkout can't resolve them; (2) core src type changes aren't seen by satellites until a rebuild. Adding `paths` → src does NOT work cleanly (it pulls core src into each satellite's `rootDir`, and `__DEV__` isn't declared outside the build-time define). Proper fix belongs in T7.2: reorder CI to `build` before `typecheck` (or add a pre-typecheck build step), and/or add TS project references plus a `__DEV__` ambient declaration so src↔src typecheck is viable. Surfaced when T1.2 added `DehydratedEntry.id` — the integration suite's hand-built payload only typechecked after a rebuild.

## Documentation / polish

### [idea] Five wiki line-range citations into `mutation.ts` point at the wrong code

Found while re-verifying citations after §6.5 landed (2026-09-03). `wiki-lint` only checks that a
`file:N-M` range is within the file, so a range that drifted onto unrelated code is silent. These
five were already wrong *before* that change — they are not shift damage from it, and they were left
alone rather than fixed mid-task:

- `pitfalls/latest-wins-rollback-order.md` → `mutation.ts:138-154` lands on the `MutationRun` type
  doc; the synchronous rollback it describes is the `case 'latest-wins'` block.
- `pitfalls/raceabort-for-misbehaving-mutate.md` → `mutation.ts:184-247` lands on `RunHandle` and
  `SerialEntry`, and `:347-374` on the `onMutate`-throw path. `raceAbort` itself is at the bottom of
  the file.
- `modules/devtools.md` → `mutation.ts:230-246` lands on the constructor parameter list, not the
  `emit` overloads it names.
- `modules/examples.md` → `mutation.ts:196-208` lands on `MutationLifecycleHooks`, not the
  `onError(err, vars, snapshot)` signature it cites.

Worth fixing as one pass over every `file:N-M` in `.wiki/`, and worth asking whether lint can do
better than an EOF check — e.g. store a hash of the cited range, or require citations to name a
symbol the range must contain.

## Loose ends

### Internal peer ranges have no upper bound

**Resolved for 0.x.** The nine sub-packages declared `peerDependencies: { "@kontsedal/olas-core": ">=0.3.0" }` with no ceiling. That was cosmetic while all ten shipped in lockstep at one version. Dropping the `fixed` group made it load-bearing, so every internal peer range now carries `<1.0.0`. The ranges read `>=0.3.0 <1.0.0`, and `>=0.9.0 <1.0.0` on mutation-queue.

Verified against this tree with throwaway changesets. An in-range bump, core 0.8.0 to 0.9.0 and zod to 0.8.1, leaves the ceilings intact and bumps nothing else. An out-of-range bump, core to 1.0.0, cascades a major to all nine and rewrites their ranges. That is the intended fence.

**What remains.** On that cascade `changeset version` rewrites `>=0.3.0 <1.0.0` to `>=1.0.0`, dropping the ceiling again: it manages the floor and discards the rest of the range. So the ceiling survives normal operation but is stripped exactly when a major lands. This is tolerable now that publishing is manual. The rewrite shows up in the "Version Packages" PR diff, which a human reviews before merging, and again before running the publish workflow. If it starts being missed, the fix is a post-`version` script that re-applies ceilings, run as part of `changeset version`.

### CI releases cannot complete without two repo-settings changes

The 0.4.0 release had to be finished by hand twice, for reasons the workflow cannot fix from inside:

1. **`GitHub Actions is not permitted to create or approve pull requests`** — the changesets action built and pushed `changeset-release/main` but could not open the Version Packages PR (run 30610698827). Fix: Settings → Actions → General → Workflow permissions → allow Actions to create PRs. Until then, every release needs a manual `gh pr create --head changeset-release/main`.
2. **No `NPM_TOKEN` repo secret exists**, because `gh secret list` is empty. The publish step therefore dies with `ENEEDAUTH` on all ten packages, as in run 30610849873. 0.3.0 and 0.4.0 were both published from a locally-authenticated machine (`npm whoami` → kontsedal) via `pnpm release`. Fix: mint an npm automation token and `gh secret set NPM_TOKEN`.

Neither blocks releasing — the local path works — but the CI pipeline is decorative until both are done.

Note the split since. `version.yml` opens the Version Packages PR and needs fix 1. `publish.yml` is `workflow_dispatch`-only, pushes to npm, and needs fix 2. Fix 1 is the more annoying of the two, because without it there is no automated PR to review and the whole version step has to be run by hand.
