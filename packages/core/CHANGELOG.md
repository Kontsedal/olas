# @kontsedal/olas-core

## 0.7.1

### Patch Changes

- db693cc: **`query.write(...)`'s supersede guard is asked after the write, not before.** 0.7.0 superseded an in-flight fetch only when the entry _already_ held canonical data. That declined to supersede in the commonest shape of the bug it was written for: open a thing, act on it, and the push carrying the result is undone by the body read issued before the action — the entry has no data yet, so 0.7.0 left the stale answer to land.

  The state the guard exists to prevent is `status: 'success'` over `undefined` with nothing in flight, which nothing refetches until `staleTime` lapses. That is reached exactly when a write both supersedes the fetch _and_ leaves `data` undefined — so the post-write value is the precise test, and the pre-write one is a proxy that is wrong in both directions.

  - A full-body write onto an entry whose first load is outstanding **now supersedes**. Nothing is stranded: the write supplies the value the fetch would have.
  - A merge that cannot patch what is not there (`prev ? fn(prev) : prev`, the usual shape over a possibly-absent key) leaves `undefined` and **still does not** supersede — that fetch is what will produce the first value.

  `Entry.hasCanonicalData()`, added in 0.7.0 for the old guard, is removed: it has no remaining caller and the post-write test does not need it. It was internal, never exported from the package, which is why this is a patch rather than a minor.

  Found by upgrading a real consumer to 0.7.0 — its own regression tests for the bug 0.7.0 was written to fix went red, because they cover the first-load case.

## 0.7.0

### Minor Changes

- 314aa28: **`query.write(...)` now supersedes an in-flight fetch.** A canonical write is newer by definition: the caller is folding in something the server has already said, while an outstanding request was issued before that happened and will answer with the state from before it. Until now that response landed last and silently undid the write — the value appeared, then vanished, with a perfectly valid server payload as the cause and nothing in the UI to explain it.

  This is a behaviour change to an existing API, and a deliberate divergence from react-query, whose `setQueryData` is clobbered the same way (measured against `@tanstack/query-core` 5.101). react-query cannot do otherwise: it has **one** door for both meanings, so it cannot tell an optimistic guess from server truth. olas has two, which is what makes the distinction expressible:

  - **`write`** — canonical. Supersedes the in-flight fetch, and rebases any live optimistic snapshots onto the written value so a later rollback restores it rather than an older baseline.
  - **`setData`** — optimistic. Unchanged: a guess, which a server response is entitled to overrule, so the cancel-before-`setData` recipe (SPEC §5.5) is still the caller's to make.

  **It supersedes only when the entry already holds _canonical_ data.** With none, the in-flight fetch is not a stale answer to discard — it is what will produce the entry's first value, and cancelling it would leave `status: 'success'` over `undefined` data with nothing to refetch it until `staleTime` lapses: a query that never loads. "Canonical" is load-bearing — an optimistic `setData` over a never-loaded entry sets `data` too, and cancelling on the strength of a guess reaches that same stranded state by another route.

  **Two known limits.** A query whose fetcher legitimately resolves `undefined` never supersedes (the cache spells "nothing here" as `undefined` throughout), so call `cancel(...)` first on one of those. And a superseded fetch is _discarded_, not re-run: if the outstanding request was a reconnect catch-up, that resync does not happen and the write carries only its own delta — `await invalidateAll()` still resolves, so a caller cannot detect it from the promise. Both are in SPEC §6.4; the second is tracked in `BACKLOG.md`.

  `query.prefetch()` also gained the AbortError recovery `subscription.refetch()` has had since T3.9: a prefetch superseded by a write now resolves with the entry's eventual value instead of rejecting.

  ```ts
  // Before: needed a cancel, and every call site had to remember it.
  tabQuery.cancel(id);
  tabQuery.write(id, () => tabFromServerPush);

  // Now:
  tabQuery.write(id, () => tabFromServerPush);
  ```

  **Migration.** Existing `cancel(...)` calls before a `write` are now redundant but harmless — `cancel` stays unconditional, so it still holds back a first load if that is genuinely what you want. Remove them at leisure. If you were relying on a fetch overwriting a `write` (unlikely — that was the bug), switch that site to `setData` and settle its snapshot, or re-invalidate after the write.

  Found by shipping it: two product bugs in a consumer app — a query-result grid blanking a moment after the results arrived, and a tab, split or panel-close undoing itself — plus a CI suite quarantined for two days over failures that were all this one cause.

## 0.6.0

### Minor Changes

- 22814ef: Two additions to the module-level `Query` handle, both surfaced by integrating olas into a real app — and one correctness distinction they make expressible.

  - **`query.peek(...keyArgs): T | undefined`** — read a keyed entry's cached data synchronously. Completes the imperative surface: `setData` and `cancel` could already reach a keyed entry from outside a subscription, while nothing could _read_ one. A peek never creates an entry (so asking cannot change the answer), never fetches, and registers **no reactive dependency** — inside a `computed` or an effect it will not cause a re-run. `undefined` means there is nothing to read: no entry (never fetched, or gc'd), or an entry that has not settled. For imperative moments — an event handler that needs the current value, a guard before a write. Reactive reads remain `ctx.use(...)`'s job.

    ```ts
    // A click handler that needs the current value, without subscribing to it.
    function onOpen(id: string) {
      const cached = userQuery.peek(id);
      open(cached?.name ?? "Loading…");
    }
    ```

  - **`query.write(...keyArgs, updater): void`** — a **canonical** cache write: patches data, pushes no optimistic snapshot, leaves `hasPendingMutations` untouched. Otherwise identical to `setData` (same entry, created if absent; same `source: 'set'` plugin/devtools event, so cross-tab and entity plugins see it as any other local write).

    This is a correctness distinction, not sugar. A `setData` snapshot exists to be settled by the mutation that created it — `onMutate` returns it, success finalizes, failure rolls back. A **fire-and-forget** patcher (folding a server push into the cache, applying a realtime event, syncing a value another view just changed) has no mutation to settle it, so every call leaves a live snapshot record on the entry: `hasPendingMutations` wedged at `true` for the entry's remaining life, and on a long-lived entry patched per server event, a snapshot array that grows without bound. Before this, application code's only options were remembering `snapshot.finalize()` on every patch or the plugin-facing `setEntryData` (not reachable from userland).

    ```ts
    // Server pushed a record — canonical, nothing to roll back.
    events.on("user:updated", (u) => userQuery.write(u.id, () => u));
    ```

  Also documented, because it produced a real (transient, self-healing, review-surviving) regression downstream: **"nothing invalidates this query" does not mean "no fetch is in flight"**, so the cancel-before-optimistic-`setData` step is not optional for un-invalidated queries. An entry refetches on its own whenever a subscription acquires it while stale — a first subscriber, a second root binding the same key, or a `resume()` after a suspend — with no invalidator anywhere. `setData`'s and `cancel`'s TSDoc, SPEC §5.5 and §6.4 now say so.

  No behaviour changes to existing APIs.

## 0.5.0

### Minor Changes

- a2b8459: Three ergonomics improvements surfaced by integrating olas into a real app:

  - **`invalidate()` / `invalidateAll()` now return `Promise<void>`** (was `void`) — on `Query`, `InfiniteQuery`, and `LocalCache`. The promise resolves when the refetch(es) they trigger have **settled** (immediately for a subscriber-less entry, which is marked stale but not refetched), and **never rejects** — a fetch error routes to the root's `onError` and stays on the entry's `error` signal. This makes `await query.invalidate(id)` a valid sequencing point ("the refresh I asked for has completed"), matching TanStack's `invalidateQueries`. Non-breaking: fire-and-forget callers that ignore the return keep working.

  - **`signal.set` / `signal.update` and `Field.set` are now bound** — stable-identity instance methods, so passing one as a value (`onChange={signal.set}`, `const setName = field.set`) no longer throws `Cannot read properties of undefined (reading 'inner')` the moment it's detached. Same guarantee as React's `setState`.

  - **New `keepDataWhileDisabled` option** on `ctx.use(query, { enabled, keepDataWhileDisabled: true })` — keeps the subscription reporting its last `data` (snapshotted when `enabled` goes false) instead of blanking to `undefined`, mirroring react-query's "a disabled observer still reads the cache" behaviour for flows that would otherwise flash empty. The entry is still released (refcount / GC unchanged) and `status` stays `'idle'`; only `data` is retained (`error` is not). Defaults to `false` — existing disabled-query behaviour is unchanged.

## 0.4.0

### Minor Changes

- f8c3b1b: `refetchInterval` accepts a function of the entry's data.

  ```ts
  type RefetchInterval<T> = number | ((data: T | undefined) => number);
  ```

  Both `QuerySpec` and `InfiniteQuerySpec` take either form. The canonical use is the one a fixed number can't express — poll fast while there's work, slowly when there isn't:

  ```ts
  defineQuery({
    key: () => ["jobs"],
    fetcher: async ({ signal }) => api.jobs(signal),
    refetchInterval: (jobs) =>
      jobs?.some((j) => j.state === "running") ? 1_000 : 30_000,
  });
  ```

  Without it you choose between a wasteful cadence at rest and a sluggish one under load, or you run a second timer beside the query and race it.

  The thunk is resolved **once per scheduling decision** — on each tick, for the _next_ gap — against the entry's latest data, read without subscribing. So it isn't reactive: a signal read inside yields that tick's value and registers no dependency. Its first call is synchronous at the 0→1 subscribe, before the initial fetch settles, so it must handle `data === undefined`. For infinite queries the argument is the entry's pages array (`TPage[] | undefined`).

  A resolved gap must be a positive finite number. `0` / `NaN` / negative / `Infinity` stops the timer for that entry with a dev warning instead of spinning a fetch-per-macrotask loop; once stopped it restarts only on the entry's next 0→1 subscriber transition (a subscriber joining an entry that still has others does not re-arm it). A thunk that **throws** is handled the same way — chain stopped, dev warning naming the throw and carrying the error — rather than escaping the timer callback, where it would end polling permanently with nothing but an uncaught error to show for it.

  It is deliberately **per cache entry, not per subscriber** — the timer belongs to the shared entry, so ten controllers on one key share one interval. That's why `UseOptions` still has no `refetchInterval` (per-subscriber intervals would need a "whose interval wins" rule) and why `DefaultQueryOptions` still excludes it. `ctx.cache` / `LocalCache` has no interval mechanism and doesn't gain one here.

  Internally both interval timers became a self-rescheduling `setTimeout` chain, since a fixed-period timer can't re-ask for its period. The cadence stays a metronome (a fetch slower than the gap doesn't stretch the schedule), and the hidden-tab skip, in-flight skip and suspend-pause behave as before. SPEC §5.9 carries the contract.

  **Two changes to disclose**, both narrow:

  - _An invalid numeric literal no longer polls._ The positive-finite rule binds the resolved gap, so it also binds a literal — `refetchInterval: 0` (or `NaN`, or negative) now warns once and never arms, where `setInterval(fn, 0)` used to clamp to about one tick and refetch every macrotask. Any code relying on that was asking for a hot loop, but the runaway fetching would have been visible, and its absence is also visible.
  - _`QuerySpec<Args, T>` is now invariant in `T`._ The thunk puts `T` in a function-parameter position, so `QuerySpec<[], Dog>` no longer flows into a `QuerySpec<[], Animal>` slot. Blast radius is small: `defineQuery` infers `T` from the fetcher, which is the normal path and is unaffected; only code that writes the type explicitly and relies on assignability between two instantiations is touched.

### Patch Changes

- aba70a3: Docs: `Mutation.reset()`'s TSDoc claimed the opposite of what it does.

  The doc line read "Clear `data` / `error` / `lastVariables` / `status` **without aborting in-flight runs**". `reset()` has aborted in-flight runs since the file's first commit, SPEC §6.2 lists it among the abort triggers, and two tests pin it (`mutation.test.ts` "reset clears data/error/lastVariables and aborts in-flight", regression B2 for the queued-`serial` rejection). The sentence was introduced by a docs-only sweep and was never true — it shipped in the published `.d.ts`, so consumers read it in editor hover.

  No behavior change. The TSDoc now states it plainly: in-flight runs abort (awaiters reject with an `AbortError`), queued `serial` runs are rejected so nothing hangs, then `data` / `error` / `lastVariables` / `status` clear and `isPending` drops.

  It also carries a migration warning, because this is a real footgun: react-query's `reset()` detaches the observer and lets the in-flight request finish, Olas's aborts it. Same name, same signature, no type error — a mechanical `reset()` → `reset()` port silently changes whether the write lands. `API.md` and `MIGRATING.md` say the same thing now.

## 0.3.0

### Minor Changes

- 939f932: `ctx.debug({...})` — controller variables in devtools.

  **Core** — new opt-in `ctx.debug(record)` primitive: registers named **live** values (signals / computeds / fields / plain values) for the devtools "Variables" view. Dev-only — a no-op in production (stripped like the rest of the `__debug` bus), so it costs nothing and retains nothing there. Construction-time registrations ride out on `controller:constructed` (new optional `debug` field); a call after construction emits the new `controller:debug` event. Both are replayed to late subscribers.

  **Devtools** — each controller node in the Tree now shows its `ctx.debug` variables, rendered **reactively** (a signal shows its current value and updates live as it changes — no polling; a plain value shows a snapshot). Lazy per expanded node.

- bba3e5c: `RootOptions.defaultQueryOptions` — root-wide query defaults.

  App-wide query policy is now declared once at `createRoot` instead of restated on every `defineQuery`:

  ```ts
  createRoot(app, {
    deps,
    defaultQueryOptions: { staleTime: 5 * 60_000, retry: 1 },
  });
  ```

  Covers `staleTime`, `gcTime`, `retry`, `retryDelay`, `keepPreviousData`, `networkMode`, `structuralShare`, `refetchOnWindowFocus`, `refetchOnReconnect`. Resolution is `spec.X ?? defaultQueryOptions.X ?? built-in`, so a per-query spec field always wins. Applies to `defineQuery`, `defineInfiniteQuery`, and `ctx.cache` (`staleTime` / `keepPreviousData` — the fields `LocalCacheOptions` carries).

  Why: the built-in defaults (`staleTime: 0`, `retry: 0`) are the right quiet choice per query, but an app wanting different ones had to repeat them N times, and a missed one presents as "why is this refetching on every subscribe?" rather than as an error. Especially relevant when porting a TanStack `QueryClient` config, whose defaults differ (`retry: 3`, `refetchOnWindowFocus: true`).

  `refetchInterval` is deliberately **not** defaultable — a root-wide interval would start background polling for every query in the app. `refetchOnWindowFocus` / `refetchOnReconnect` are no-ops for infinite queries, which install no focus/reconnect subscription.

  Additive and backward-compatible: omitting the option preserves today's behavior exactly. The pre-existing flat `RootOptions.refetchOnWindowFocus` / `refetchOnReconnect` keep working as shorthand; the `defaultQueryOptions` entry wins when both are set. `createTestController` accepts the option too, so controllers whose behavior depends on it are testable in isolation.

## 0.2.0

### Minor Changes

- eb859d9: Devtools causal timeline (overhaul T8.1 + T8.4).

  **Core** — `DebugEvent` gains optional `seq` / `t` / `causeId` correlation fields (stamped by the bus), plus new `cache:set-data` (carries `source` + the post-write `data`) and `snapshot:push` / `snapshot:rollback` / `snapshot:finalize` events. A mutation run's id and each fetch's id thread through the writes and snapshot events they trigger, so a whole optimistic-update chain shares one `causeId`. All dev-only — stripped from production builds. See SPEC §14.

  **Devtools** — new default **Timeline** tab: every event ordered by `seq` and grouped by `causeId` into collapsible cause-chains, each `cache:set-data` expandable to a structural before/after diff. The cache Inspector is now event-driven (the 800ms poll is gone). Also fixes a real-browser `Illegal invocation` crash of the rAF-coalesced flush (native `requestAnimationFrame` was assigned unbound), which had silently left the Cache / Mutations / Fields / Timeline views empty in every browser.

## 0.1.0

### Minor Changes

- ba0b9cb: Remediation correctness pass — a full-repo deep audit (five independent review passes, worst findings pinned with probe tests) fixed across core + every satellite. Released as a **minor** bump under the 0.x convention to signal the documented behavior changes (listed at the end).

  Highlights:

  - **Query cache:** hydration is namespaced by query identity (no cross-query data theft); plugin/remote `setData` no longer leaks snapshots or wedges `hasPendingMutations`; out-of-order optimistic rollback fixed; `refetchInterval` no longer livelocks when a fetch outlasts the interval; infinite-query status no longer wedges at `'pending'`; new `query.cancel(...)` / `cancelAll`; `networkMode: 'offlineFirst'` implemented + `AsyncState.isPaused`; `stableHash` Date/class handling fixed.
  - **Lifecycle:** a key change while suspended no longer bricks the subscription; every `ctx.*` factory throws consistently after dispose; `ctx.collection` reconcile no longer tracks user-code reads; explicit item suspension survives a tree suspend/resume; `debounced`/`throttled` gain `dispose()`.
  - **React:** `HydrationBoundary` owns its root (no StrictMode leak / no unmount leak); `Mutation.status` drives `useMutation`'s `isSuccess`/`isIdle`/`isError` (fixes `void` mutations reading idle forever); `useSuspenseQuery` keeps stale data on a background-refetch failure; `use(signal, { select })` re-derives when the selector changes; KeepAlive is refcounted.
  - **Forms:** structural `FieldArray` edits mark `isDirty` (a background refetch no longer deletes rows the user just added); form-/array-level validators can target specific fields by returning `FormIssue[]`, and the Standard-Schema adapter preserves each issue's `path`; `required(false)` now passes and a new `mustBeTrue` covers consent checkboxes; `isValid` holds its last settled value while validating (no submit-button strobe).
  - **Satellites:** persist gained IndexedDB commit-ack + honest error routing and now-tested `version`/`migrate`/`throttleMs`/`onError`; mutation-queue gained reconnect replay, cross-tab replay coordination (Web Locks + lease), and `onReplaySettle` cache reconciliation (and is honestly labelled "best-effort"); devtools fixed the false-`[Circular]` render + unbounded tree growth; cross-tab dropped the dead `crossTab: 'infinite'|'both'` values and filters on receive; zod fixed an async abort-race and warns on duplicate-copy schemas; router seeds SSR route state and widened `params`; realtime reports `'unknown'` connection state instead of lying `'connected'`.

  Full detail: `.wiki/log.md` (phase 0–6 ingests) + the per-package CHANGELOGs.

  **Behavior changes to note:** `required(false)` now accepts a boolean; `crossTab` no longer accepts `'infinite'` / `'both'`; form-level validators may return `FormIssue[]`; a field's `isValid` no longer flips `false` purely because a validation is in flight; realtime `ConnectionState` gains `'unknown'`; calling any `ctx.*` factory after dispose now throws.

## 0.0.7 – 0.0.15

> Versions bumped in lockstep across the workspace but **never published** — npm stayed at `0.0.6` (2026-05-21). Summaries reconstructed from `git log`; the next published release (see the pending changeset) rolls these up together with the remediation correctness pass.

- **0.0.15** — streaming SSR phase 2 (client batching + Web `TransformStream`)
- **0.0.14** — streaming SSR foundation (phase 1)
- **0.0.13** — key-hash hardening, form `clearSubtree`, SSR `HydrationBoundary` (batch 6)
- **0.0.12** — O(1) lifecycle teardown + `ctx` reactive primitives + mutation-queue size guard (batch 5)
- **0.0.11** — signal/controller DX + realtime/collection ergonomics (batch 4)
- **0.0.10** — ergonomic completions, devtools coalescing, mutation-queue hardening (batch 3)
- **0.0.9** — ergonomic completions + plugin upgrades (review batch 2)
- **0.0.8** — correctness pass + ergonomic upgrades (review findings)
- **0.0.7** — correctness pass on `lazyChild`, forms, mutation-queue, keep-alive

## 0.0.6

### Patch Changes

- Phase 0.2b — Router adapter package + `RootOptions.scopes` for cross-cutting scope seeding.

  Treated as patch under the 0.x.y line — purely additive across the existing nine packages, plus one new opt-in package.

  **Core — `RootOptions.scopes`**

  - New `scopes?: ReadonlyArray<[Scope<unknown>, unknown]>` option on `createRoot`. Pre-seeds scopes on the root controller instance BEFORE its factory runs so `ctx.inject(...)` resolves them from any descendant. Useful for adapters that want to publish cross-cutting values without forcing the user's root controller to call `ctx.provide(...)`. Later bindings for the same scope override earlier ones.

  **New package: `@kontsedal/olas-router`**

  A generic, router-agnostic adapter for wiring any client-side router (TanStack Router, React Router v6, or your own) into the olas controller tree via three scopes:

  - `RouteParamsScope: Scope<ReadSignal<Record<string, string>>>`
  - `RouteSearchScope: Scope<ReadSignal<Record<string, unknown>>>`
  - `RoutePathnameScope: Scope<ReadSignal<string>>`

  `createRouterAdapter()` returns `{ scopes, Bridge }`. `scopes` plugs into `createRoot({ scopes: adapter.scopes })`; `<adapter.Bridge params={...} search={...} pathname={...}>` mounts inside the React tree and pushes router state into the underlying signals on every change.

  Each `createRouterAdapter()` call mints its own signal store, so per-request SSR roots and isolated test fixtures don't share state. Shallow-equals incoming `params` / `search` records to avoid spurious writes when the router allocates fresh object literals on every render.

  **Next.js is not supported** — see `BACKLOG.md` for the philosophy reasoning.

  **Recipes**

  - `RECIPES.md` Router-integration section rewritten to use `@kontsedal/olas-router`. Both TanStack Router and React Router v6 wire-up patterns shown; each is ~5 lines of user code (call the router's hooks, pass values into `<adapter.Bridge>`).

  Tests: +10 (4 RootOptions.scopes, 6 router adapter), total 590 passing. Typecheck clean. Biome clean (0 errors).

## 0.0.5

### Patch Changes

- Phase 0.3 — Persisted mutation queue. New package `@kontsedal/olas-mutation-queue`.

  Treated as patch under the 0.x.y line — purely additive across the existing eight packages, plus one new opt-in package.

  **New package: `@kontsedal/olas-mutation-queue`**

  A `QueryClientPlugin` that persists `defineMutation({ persist: true })` runs to a `StorageAdapter` and replays pending entries on `init`. Use case: a checkout-flow `createOrder` mutation in-flight when the user reloads or the browser crashes — the queue replays it on the next page load so the user doesn't lose the request.

  - `mutationQueuePlugin({ adapter, keyPrefix, maxAttempts?, onReplayError?, onWarn? })`
  - Per-`mutationId` serial replay; different mutationIds run in parallel.
  - Bounded retries via `maxAttempts` (default 5); attempts counter persists across reloads.
  - `onReplayError` fires when an entry exhausts retries OR references an unregistered `mutationId` (typical when the module hasn't been imported yet — the entry stays in storage until the module loads).
  - Idempotency is the consumer's responsibility — include a stable `idempotencyKey` in variables, have the server dedupe.

  **Core**

  - `defineMutation({ mutationId, mutate, ... })` — module-scope registration so the queue plugin can find the handler on replay, BEFORE any controller exists. Returns the spec unchanged (with a `__olas: 'mutation'` brand); pass it to `ctx.mutation(...)` with optional spread of per-controller hooks like `onSuccess`.
  - `MutationSpec` gains `mutationId?: string` and `persist?: boolean`. `ctx.mutation` validates that `persist: true` requires a non-empty `mutationId`.
  - `QueryClientPlugin` gains `onMutationEnqueue` / `onMutationSettle` hooks. `MutationEnqueueEvent` / `MutationSettleEvent` exported.
  - `lookupRegisteredMutation` exported alongside `lookupRegisteredQuery` for plugin lookups.
  - `MutationLifecycleHooks` internal type wired in `createMutation` — only emits when `spec.persist === true`.

  **Persist**

  - `StorageAdapter` gains optional `keys(): Iterable<string> | Promise<Iterable<string>>` so consumers (like the mutation queue) can enumerate pending entries. Both `localStorageAdapter` and `indexedDbAdapter` implement it.

  **Recipes**

  - `RECIPES.md` gains a "Persisted mutations" section with the canonical pattern: module-level `defineMutation`, root-level `mutationQueuePlugin`, controller-level `ctx.mutation` with spread, and the idempotency-key convention.

  Tests: +11 (queue plugin coverage), total 580 passing. Typecheck clean. Biome clean (0 errors).

## 0.0.4

### Patch Changes

- Phase 0.2 — React Suspense + ErrorBoundary integration, `subscription.promise()`, and router-integration recipes.

  Treated as patch under the 0.x.y line — purely additive.

  **React Suspense**

  - `useQuery(subscription, { suspense: true })` in `@kontsedal/olas-react`.
    Throws `subscription.promise()` while pending (caught by `<Suspense>`),
    throws `subscription.error` on error state (caught by `<ErrorBoundary>`),
    returns synchronously on success with `data` narrowed to `T` (never
    `undefined`).
  - Only the **first load** suspends — refetches after a first success keep
    `data` defined and the hook returns normally. Matches TanStack Query's
    suspense semantics.

  **Core**

  - `subscription.promise()` — alias of `firstValue()` with a clearer name
    for Suspense / `React.use(...)` ergonomics. Resolves on first success
    (short-circuits if already settled), rejects on error. Exposed on
    `AsyncState<T>`, so it's available on `QuerySubscription`, `LocalCache`,
    and `InfiniteQuerySubscription`.
  - `ctx.use`'s overloads now accept readonly key tuples (`() => [...] as const`)
    on the no-select and select-projecting forms — fixes a regression where
    the select overload couldn't be picked when the key thunk returned a
    readonly array.

  **React adapter**

  - `useField` now exposes `setErrors(string[])` so a `<form>` component can
    inject server-side validation results without reaching into the field
    directly.

  **Recipes**

  - `RECIPES.md` gains a Router-integration section covering TanStack Router,
    React Router v6, and Next pages router. The pattern is consistent across
    routers: bridge the router's params to a `signal`, expose it via a
    `Scope`, and consume from `ctx.inject(...)` in any controller that
    depends on the route. Includes patterns for route-scoped controllers via
    `ctx.session` and route-loader-driven prefetch.

  Tests: +6, total 569 passing. Typecheck clean. Biome clean (0 errors).

## 0.0.3

### Patch Changes

- Phase 0.1 — Standard Schema adapter, form.submit lifecycle, structural sharing on refetch, and select projection.

  Treating as patch under the 0.x.y line — the changes are additive and don't break any pinned behavior.

  **Standard Schema**

  - New `validator(schema)` in `@kontsedal/olas-core` accepts any
    `StandardSchemaV1`-compatible schema (Zod 4, Valibot 1, ArkType 2, …).
    Sync vs async is handled transparently — the wrapper returns a Promise
    only when the underlying schema does.
  - `StandardSchemaV1` type is re-exported for consumers who want the type
    without taking a dep on `@standard-schema/spec`.
  - `zodValidator` in `@kontsedal/olas-zod` is now a thin alias over
    `validator(...)` — Zod 4 implements Standard Schema, so the Zod-specific
    path is now indirected through the cross-library one.

  **Forms**

  - `form.submit(handler, options?)` — first-class submission lifecycle.
    Returns `{ ok, data?, error? }`. Pre-validates (skippable), marks every
    field touched on invalid, captures handler throws to `submitError` and
    refuses parallel submits.
  - `form.isSubmitting` / `form.submitCount` / `form.submitError` signals.
  - `field.setErrors(string[])` — pin externally-sourced errors (typically
    from a failed submit). These live in a separate `serverErrors` channel,
    survive validator re-runs, and auto-clear on the next user write to the
    field.
  - `form.setErrors({ 'user.email': [...], 'tags.1': [...] })` — same
    channel as `field.setErrors`, routed by dot-separated path through
    nested forms and field arrays (numeric segments are array indices).
  - `field.reset()` and `form.reset()` clear the server-errors channel too.

  **Queries**

  - Structural sharing on refetch: `Entry.applySuccess` walks the previous
    data and the new payload, returning the previous reference wherever a
    sub-tree is deep-equal. Unchanged refetches now produce `===` results,
    so downstream `computed`s and React snapshots stop thrashing. Bails on
    `Map` / `Set` / `Date` / `RegExp` / class instances. Cycle-guarded with
    a `WeakSet`. Also wired into `InfiniteEntry.startFetch` so the head
    page's identity survives a no-op refresh.
  - New `select` overload on `ctx.use(query, { key, select: (data) => U })`.
    Projects the underlying `T` to a view `U` via a per-subscription
    `computed`. Combined with structural sharing, a stable `select` over an
    unchanged payload outputs the same reference — downstream consumers
    dedupe via `Object.is` and don't re-render. `refetch()` and
    `firstValue()` project through `select` too.

  Tests: +50, total 563 passing.

## 0.0.2

### Patch Changes

- Round of correctness fixes from a multi-agent code review.

  **Core**

  - `isAbortError`: now matches any object whose `name === 'AbortError'`, not just
    `DOMException`. axios / msw / custom plain Errors that signal abort no longer
    trip retry loops.
  - `createEmitter`: emit-time handler throws are isolated — one throwing handler
    no longer blocks subsequent handlers (spec §20.6). `createEmitter({ onError })`
    accepts a reporter; `ctx.emitter()` wires it to the root's `onError` with
    `kind: 'emitter'`.
  - `readOnly()`: returned object is now `Object.freeze`d so `(ro as any).value = …`
    throws in strict mode rather than silently mutating.
  - `debounced` / `throttled`: both accept an optional `{ signal: AbortSignal }`
    so the internal effect, pending timer, and `source` subscription can be torn
    down. Without it the helpers retain the source for the program's lifetime —
    pass a signal whenever the source outlives the consumer.
  - `ctx.lazyChild`: explicit `lazyChild.dispose()` now also splices the internal
    parent-dispose flag entry. Prior code left one closure on the parent's
    lifecycle list per ever-disposed lazyChild — slow leak in apps that repeatedly
    open and close code-split children.
  - `Form.set({ tags: [...] })`: array-shaped patches now preserve item identity
    on overlapping indices instead of `clear() + add()`-ing every position.
    Touched / dirty / in-flight validators on existing items survive the patch.
    `resetWithInitial` also re-anchors `initialItems` on the underlying
    `FieldArray` so a later `reset()` returns to the most-recently-applied initial.

  **Entities**

  - `entities.update()` on an id that isn't in the store no longer allocates an
    empty slot via `getSlot`. Under `maxSlots`, the orphan allocation could
    LRU-touch a never-seen id ahead of real entities and trigger spurious
    eviction. The no-op path is now truly side-effect-free.

  **Cross-tab**

  - The internal `seenByPeer` Map is now bounded (cap 64) with LRU-style
    eviction. A long-lived tab seeing many short-lived peers no longer grows
    this Map without bound, and `dispose()` clears it.

  **Devtools**

  - `TreeView` rules-of-hooks bug: `useMemo` was called after an early-return
    on empty trees, so the hook order changed across renders. Now computed
    unconditionally.

- 6869769: Initial release candidate.

  First public publish to npm. All seven packages move from 0.0.0 → 0.0.1-rc.0
  in lockstep so cross-package version skew stays at zero through the RC line.

  What's in this RC, beyond the baseline architecture (controllers, signals,
  queries, mutations, forms, scopes, SSR):

  - `@kontsedal/olas-core`: `selection` composable (spec §17.5) — multi-select with
    shift-click range + meta-click toggle, Finder-style snapshot semantics so
    subsequent shift-clicks can shrink or grow the range.
  - `@kontsedal/olas-realtime`: `useRealtimePatcher` + `defineLiveStream` (spec §16.5).
  - `@kontsedal/olas-cross-tab`: `BroadcastChannel`-backed cache sync (spec §13.2).
  - `@kontsedal/olas-devtools`: in-app `DevtoolsPanel` + draggable floating launcher.
  - Production builds strip `__DEV__` guards (commit d39708a) so devtools
    emission and field-validation hooks drop out of prod bundles.

- 7a07994: Fill npm package metadata.

  Every publishable package now has `repository` (linking npm → github source
  directory), `homepage` (deep-linking the per-package README), `bugs.url`
  (github issues), `author` (Bohdan Kontsedal), and a focused `keywords`
  list. Descriptions tightened to one sentence each. No code change — purely
  manifest metadata that surfaces on the npm package page.

## 0.0.1-rc.1

### Patch Changes

- Fill npm package metadata.

  Every publishable package now has `repository` (linking npm → github source
  directory), `homepage` (deep-linking the per-package README), `bugs.url`
  (github issues), `author` (Bohdan Kontsedal), and a focused `keywords`
  list. Descriptions tightened to one sentence each. No code change — purely
  manifest metadata that surfaces on the npm package page.

## 0.0.1-rc.0

### Patch Changes

- Initial release candidate.

  First public publish to npm. All seven packages move from 0.0.0 → 0.0.1-rc.0
  in lockstep so cross-package version skew stays at zero through the RC line.

  What's in this RC, beyond the baseline architecture (controllers, signals,
  queries, mutations, forms, scopes, SSR):

  - `@olas/core`: `selection` composable (spec §17.5) — multi-select with
    shift-click range + meta-click toggle, Finder-style snapshot semantics so
    subsequent shift-clicks can shrink or grow the range.
  - `@olas/realtime`: `useRealtimePatcher` + `defineLiveStream` (spec §16.5).
  - `@olas/cross-tab`: `BroadcastChannel`-backed cache sync (spec §13.2).
  - `@olas/devtools`: in-app `DevtoolsPanel` + draggable floating launcher.
  - Production builds strip `__DEV__` guards (commit d39708a) so devtools
    emission and field-validation hooks drop out of prod bundles.
