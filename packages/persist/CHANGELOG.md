# @kontsedal/olas-persist

## 1.0.1

### Patch Changes

- e5f9834: **`persistQueryCachePlugin` keeps other tabs' entries, and `createPersisted` survives storage that fails or a value set to `undefined`.**
  
  - `persistQueryCachePlugin` reads storage before every write and merges this session's entries into it. Each write used to put the tab's own map over the shared key, which deleted every entry another tab had stored since. When two tabs hold a copy of one entry, the one with the newer `lastUpdatedAt` is kept. A tab that restored an old copy no longer writes it over a peer's fresher fetch. With `restore: false` the plugin no longer reads storage at startup, since every write reads it.
  - `createPersisted` round-trips `undefined`. It is stored as `{"$olas":1}`, or `{"$olas":1,"v":N}` with `version`, and a reload and another tab both read `undefined`. With `version` it used to read back as the object `{ $olas: 1, v: N }`. Without it the write failed as `'serialize'`, and a reload brought back the value the user had cleared.
  - Another tab's delete puts back the value the source held before the load, which is what a reload shows. It used to set the source to `undefined`, whatever its type.
  - A synchronous `storage.get` that throws reports `onError('load')`, as a rejected one does, and `ready` settles. It used to throw out of the controller factory.
  - `localStorageAdapter` treats a `localStorage` that throws when read, as in a sandboxed iframe or with site data blocked, as missing.
  - A `serialize` that returns no string reports `'serialize'` instead of storing a broken payload.
  - `indexedDbAdapter` opens a new connection after the browser closes its connection, as WebKit does when its IndexedDB server goes away. An op that meets the closed connection before its `close` event retries once on a new one. Every later op used to fail with `InvalidStateError` for the rest of the session.
- e5f9834: **`persistQueryCachePlugin` stores server truth, never a guess, and stores a commit.**
  
  - The plugin stores each entry's server truth, the write event's `server`. A `write`, a `replace` or an infinite page fetched while an optimistic write was live used to store the guess on screen, and a reload brought a failed guess back.
  - A committed optimistic write is stored, stamped with the server time of the data it was made on.
  - A commit on an entry the server never answered for, such as an optimistic create, is not stored. It is stamped `0`, and a restore would drop it under `maxAgeMs`; the next load fetches it.

## 1.0.0

### Major Changes

- 6e154ef: **The satellite packages follow the `create*` rule, and the router installs as a plugin.**
  
  A function that takes `ctx` and builds something is named `create*`. The `use*` names read as React hooks to people and to `eslint-plugin-react-hooks`, which reports them inside a controller factory.
  
  | Package | 0.8 | 1.0 |
  |---|---|---|
  | persist | `usePersisted(ctx, key, source, opts)` | `createPersisted(ctx, key, source, opts)` |
  | persist | `localStorageAdapter` (an object) | `localStorageAdapter()` (a factory, like `indexedDbAdapter()`) |
  | persist | `clearPersisted(storage, prefix, onError)` | `clearPersisted(storage, { prefix, onError })` |
  | realtime | `useRealtimePatcher` | `createRealtimePatcher` |
  | realtime | `useLiveStream` | `createLiveStream` |
  | realtime | `useRealtimeConnection` | `createConnectionState` |
  | zod | `formFromZod(ctx, schema, { initials })` | `createZodForm(ctx, schema, { initial })` |
  | router | `createRoot(def, { scopes: adapter.scopes })` | `createRoot(def, { plugins: [adapter.plugin] })` |
  
  **router.** `createRouterAdapter()` returns `{ plugin, Bridge }`. The plugin provides `RouteParamsScope`, `RouteSearchScope` and `RoutePathnameScope` to the root it is installed on. `ROUTER_PLUGIN_NAME` is exported.
  
  **persist.** `throttleMs` is documented as what it always was: a trailing throttle, at most one write per window, carrying the latest value.
  
  **zod.** `createZodForm`'s `initial` also accepts a function. The form tracks it the way `createForm` tracks a function `initial`, so a form seeded from a query re-seats when the data arrives. `resetOnInitialChange` passes through.
  
  **mutation-queue.** The queue writes a run's entry before the run's first `mutate` call, from `wrapMutate`. A reload during the request no longer loses the run. The write adds one storage round trip before the first request. A write that fails is reported through `onWarn`, and the run proceeds without durability, as before.
  
  **core.** `MutateContext.origin` names the plugin that started a run through `host.mutations.run`, or is `undefined` for an app run. A run whose `mutate` resolved and whose abort landed in the same tick reported both `success` and `cancel` to plugins. It now reports `success` only.
  
  **react.** Streamed hydration reached only the first `HydrationBoundary`: a second boundary, or a StrictMode remount's new root, took the intake away from it. Every installed root now receives the batches that already arrived and each one that follows.
- af217d0: **ESM only, Node >= 20.19.** Every package ships one format: `dist/*.js` with `dist/*.d.ts`. The CommonJS build (`.cjs` and `.d.cts`) is gone. A CommonJS consumer can still `require()` the packages on Node 20.19 or later, which loads ES modules through `require()`. `engines.node` is `>=20.19`.
  
  **Types.**
  - Internal members no longer ship in the `.d.ts` files. That includes `Ctx`'s internals and the whole `QueryClient` class, which reached the declarations through them.
  - Every type that appears in a public signature is exported. New core exports: `DebugEventBody`, `DefineControllerOptions`, `StandardSchemaV1Issue`, `StandardSchemaV1Result`, `QuerySelectOptions` and `TimingOptions`.
  - New exports elsewhere:
    - react: `OlasProviderProps`, `HydrationBoundaryProps`, `SuspendOnUnmountProps`, `OlasContext`, `UseValueOptions`, `UseValueSelectOptions` and `UseFieldInputOptions`;
    - entities: `EntityOptions`;
    - zod: `UnwrapZod`.
  - `isStandardSchema` and `ErrorContextInput` are no longer exported from core.
  - `createQuery`'s `select` form accepts `keepDataWhileDisabled`, like the other forms.
  
  **Bundle size.** A bundle built from the published files that imports only controllers and signals carries no forms code. The forms classes had set their brands as class fields, which kept them in every bundle.

### Minor Changes

- 360120c: **A development build behind a `development` export condition.** Devtools now work against the published packages.
  
  Until now, the release build inlined `__DEV__ = false`, so the core on npm emitted no devtools events at all. `@kontsedal/olas-devtools` showed an empty controller tree and timeline against it, and the dev-only warnings in core, entities, persist, react and zod never fired in an app.
  
  Each of these packages now ships two builds:
  - `dist/` is the default, a production build with every dev-only branch stripped;
  - `dist/dev/` sits behind the `development` condition, with the devtools events and the dev warnings kept.
  
  Vite's dev server, webpack and Rspack in development mode, and Next.js in dev resolve `development` without configuration, and their production builds resolve the default. With esbuild or Rollup, add `conditions: ['development']` to the dev config; in Node, `--conditions=development`. A browser with no bundler, or a CDN, gets the default build, as before.
  
  The production build is unchanged, and so are the bundle sizes. SPEC §23 has the details.
- 6a561d9: `clearPersisted` now refuses to guess its scope.
  
  Called with no prefix it deleted every key the adapter could enumerate. The default adapter is `localStorage`, which the whole origin shares, so a "log out" also took the analytics ids, the consent record and whatever a third-party script had stored. The call now throws unless it is given a non-empty `prefix` or an explicit `{ all: true }`.
  
  The signature is `clearPersisted(storage, { prefix, all, onError })`. An adapter with no `keys()` used to return silently; it now reports through `onError` under the key `'<keys>'`, so a caller can tell "nothing to delete" from "cannot enumerate". The function had no tests at all and now has six.
  
  **Migration.** `clearPersisted()` and `clearPersisted(adapter)` throw. Pass `{ prefix: 'my-app/' }` for the scope you meant, or `{ all: true }` to keep the old behavior.
- 0ce21f3: **New first-party plugins, and helpers for testing plugins.**
  
  **persist: `persistQueryCachePlugin`.** It keeps the query cache across reloads. Queries opt in with `meta: { persist: true }`, or an `include` function decides.
  - Canonical writes are written to storage, throttled. Optimistic writes and rollbacks are skipped, and a garbage-collected entry leaves storage.
  - The stored cache is restored when the root starts. A different `buster`, or an entry older than `maxAgeMs`, is dropped.
  - With asynchronous storage (IndexedDB), the restore fills only entries no one has subscribed to yet, and `root.waitForIdle()` waits for it.
  - `restoreQueryCache(options)` reads the cache ahead of `createRoot` for `hydrate`, when the first render must see it.
  - Infinite queries persist with their page params.
  
  **core `/testing`.**
  - `mockFetchPlugin(handlers, options?)` answers query fetches by id: canned data, a function of the attempt, or an error, with latency that honors cancellation. An unmocked query fails its fetch unless `passthrough: true`.
  - `createPluginRecorder()` records every plugin observation event, for assertions.
  
  A plugin authoring guide is in `PLUGINS.md`.

### Patch Changes

- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- 9ed7356: Two fixes in `createPersisted`.
  
  - **A reader without `version` no longer takes a versioned envelope for the value.** A tab left open across a deploy runs the old build next to the new one. When the new build set `version` and the old one did not, the old tab handed the whole `{"v":2,"d":"…"}` envelope to `deserialize` and put that object in the signal. A reader without `version` now unwraps the envelope. To keep that from misreading a value of yours with the same shape, the envelope now carries a marker, `{"$olas":1,"v":2,"d":"…"}`. Without `version`, a value is still written raw, and only a value a reader could take for an envelope is wrapped, as `{"$olas":1,"d":"…"}`. Stored data keeps reading as before: the unmarked envelope is still an envelope to a reader with `version`, and a build before 1.0 with `version` set reads the marked one.
  - **A source that does not call back on subscribe keeps its first change.** `createPersisted` skipped the first call of the source's `subscribe` handler. That assumed every source calls it at once with the current value, as a signal does. A source that calls it only on a change, like an event emitter, lost its first change. Only a call made while `subscribe()` runs is skipped now.
- 4aa2542: **persist: the query cache keeps what a session never visited, and cross-tab sync no longer diverges or skips `migrate`.**
  
  - **`persistQueryCachePlugin` with `restore: false` no longer deletes stored entries this session did not bind.** On the documented path, `restoreQueryCache` into `hydrate`, the plugin knew only the entries a query bound, and its first write replaced storage with those. A session that visited only page B dropped page A's entry. The plugin now reads storage at startup whether or not it restores, and with async storage its first write waits for that read.
  - **`createPersisted` drops a pending throttled write when another tab's change arrives.** With `throttleMs`, the older local value used to land after the other tab's newer one, and the tabs disagreed from then on.
  - **`createPersisted` runs `migrate` on a cross-tab change, as it does on load.** A tab still running an old build could put an old-shaped, unversioned value straight into a versioned signal. The migrated value is not written back, because the old build still reads that key.
- 5d58d4d: **`createPersisted` and `persistQueryCachePlugin` no longer overwrite storage they should keep.**
  
  - `createPersisted` skips writing a migrated value back when another tab's change arrived during the load. The rewrite used to land over the change it had just applied, and the IndexedDB adapter broadcast the stale value to the other tabs.
  - A payload from a newer `version` no longer reaches `migrate`, on load or from another tab. A step migrator passed it through unchanged, so an older build held the newer shape, and on load wrote it back under its own version. The source keeps its default, and storage keeps the payload.
  - `persistQueryCachePlugin` holds its writes after a failed storage read, and the next flush reads storage again first. A transient read error used to make the next flush delete every stored entry this session had not bound.
  - `persistQueryCachePlugin` drops a stored entry whose query the root has used and `include` now rejects, instead of writing it back until `maxAgeMs`.
  - `indexedDbAdapter` uses the global `BroadcastChannel` only in a browser tab or web worker. On a server, a channel reaches every request in the process. Pass `broadcastChannel` to opt in anywhere.
- 38cf416: **Security pass: streamed SSR, stored state, and prototype keys.** SPEC §22 now states what Olas trusts and what it checks.
  
  **react.**
  - **XSS fix: `createStreamingTransform` writes a hydration batch only between elements.** React writes its stream in fixed-size chunks, so a chunk can end inside a tag or an attribute value. The transform used to write a `<script>` after every chunk. The payload's quotes could then close the attribute and turn query data into new attributes, such as an event handler. The transform now tracks the markup it passes through, and holds a batch until a chunk ends between elements.
  - **The streamed payload is `JSON.parse("…")` over a fully escaped string.** An own `__proto__` key in query data stays a property on the client. Before, it became the object's prototype. No quote, angle bracket, `=`, U+2028 or U+2029 reaches the script raw.
  - **New: `createStreamingHydrator({ nonce })`** puts a CSP nonce on every tag it emits.
  - **A page element with the id `__OLAS_HYDRATION__` no longer breaks streamed hydration.** The bootstrap and each batch check that the global is the intake.
  
  **core.**
  - **New: `serializeForScript(value)`**, the escaping the streaming hydrator uses, for any state an app inlines into a page: `<script>window.__OLAS_STATE__ = ${serializeForScript(root.dehydrate())}</script>`.
  - **New: `host.mutations.get(id)`** returns a registered definition's `id` and `meta`.
  - **Hydration skips an entry it cannot read**, such as `null` or a key nested too deep to hash, and hydrates the rest. Before, one bad entry made `createRoot({ hydrate })` throw.
  - **`Form.set` and `setAsInitial` ignore keys the form does not own.** A partial parsed from JSON with a `__proto__`, `constructor` or `toString` key used to throw.
  
  **mutation-queue.**
  - **Replay runs only mutations whose definition has `meta.persist: true`.** An entry in storage could name any registered mutation and have it run on the next load.
  - **An entry stored under a key its contents do not name is dropped.** Every later write and delete used the contents' key. So such an entry stayed in storage and replayed on every load. A `migrate` that renames the mutation hit the same loop; the migrated entry is now rewritten under its new key and the old one deleted.
  - **Entries are checked in full.** The attempt count must be a whole, non-negative number, `seq` finite, and `enqueuedAt` no later than a few minutes from now, so a future timestamp cannot escape `ttlMs`.
  
  **persist.**
  - **`persistQueryCachePlugin` drops a stored entry dated in the future.** It passed `maxAgeMs` and stayed fresh for any `staleTime`, so planted data never refetched.
  - **An async restore that fails now reaches `onError`**, as a sync one does.
  - **`createPersisted` reports a stored value its source refuses as `'deserialize'`**, and still settles `ready`. It used to leave `ready` false and stop persisting.
  
  **cross-tab.**
  - **A peer message the engine cannot apply is reported through `onWarn`**, not thrown out of the channel's handler.
  - **A `msgId` that is not a safe non-negative integer is ignored.** `Number.MAX_VALUE` posted under a peer's id used to silence that peer.
  - **New: `validate(queryId, data)` option** to reject a payload shape this tab does not expect.
  
  **entities.** **`entities.update(…, { merge: 'deep' })` keeps a `__proto__` key in the patch as data.** It used to replace the merged entity's prototype.
- Updated dependencies [beab02a]
- Updated dependencies [f9b34a7]
- Updated dependencies [d5642d5]
- Updated dependencies [ae18408]
- Updated dependencies [008d8ef]
- Updated dependencies [008d8ef]
- Updated dependencies [1c6964e]
- Updated dependencies [360120c]
- Updated dependencies [a2b8b14]
- Updated dependencies [008d8ef]
- Updated dependencies [325ecf3]
- Updated dependencies [6e154ef]
- Updated dependencies [153261f]
- Updated dependencies [518f5d9]
- Updated dependencies [af217d0]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [372b013]
- Updated dependencies [cdb6b77]
- Updated dependencies [cdb6b77]
- Updated dependencies [cdb6b77]
- Updated dependencies [008d8ef]
- Updated dependencies [cdb6b77]
- Updated dependencies [3d95f3c]
- Updated dependencies [fea5505]
- Updated dependencies [cb08097]
- Updated dependencies [b0f1c41]
- Updated dependencies [325ecf3]
- Updated dependencies [a328f3a]
- Updated dependencies [a328f3a]
- Updated dependencies [8aaf0e7]
- Updated dependencies [d0b11ef]
- Updated dependencies [023eaf3]
- Updated dependencies [0ce21f3]
- Updated dependencies [2174dce]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [6caffb5]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [3f9b98d]
- Updated dependencies [325ecf3]
- Updated dependencies [a29b4ea]
- Updated dependencies [3f9b98d]
- Updated dependencies [20473ba]
- Updated dependencies [1299818]
- Updated dependencies [38cf416]
- Updated dependencies [4c47f81]
- Updated dependencies [38cf416]
- Updated dependencies [02b45f2]
  - @kontsedal/olas-core@1.0.0

## 0.8.0

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [939f932]
- Updated dependencies [bba3e5c]
  - @kontsedal/olas-core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [eb859d9]
  - @kontsedal/olas-core@0.2.0

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

### Patch Changes

- Updated dependencies [ba0b9cb]
  - @kontsedal/olas-core@0.1.0

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

- Updated dependencies
  - @kontsedal/olas-core@0.0.6

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

- Updated dependencies
  - @kontsedal/olas-core@0.0.5

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

- Updated dependencies
  - @kontsedal/olas-core@0.0.4

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

- Updated dependencies
  - @kontsedal/olas-core@0.0.3

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

- Updated dependencies
- Updated dependencies [6869769]
- Updated dependencies [7a07994]
  - @kontsedal/olas-core@0.0.2

## 0.0.1-rc.1

### Patch Changes

- Fill npm package metadata.

  Every publishable package now has `repository` (linking npm → github source
  directory), `homepage` (deep-linking the per-package README), `bugs.url`
  (github issues), `author` (Bohdan Kontsedal), and a focused `keywords`
  list. Descriptions tightened to one sentence each. No code change — purely
  manifest metadata that surfaces on the npm package page.

- Updated dependencies
  - @kontsedal/olas-core@0.0.1-rc.1

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

- Updated dependencies
  - @olas/core@0.0.1-rc.0
