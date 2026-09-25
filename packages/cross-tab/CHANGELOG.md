# @kontsedal/olas-cross-tab

## 1.0.1

### Patch Changes

- e5f9834: **A peer's write is applied as what it was: a guess stays a guess, and a replace is a replace.**
  
  - A peer's optimistic write is shown as a guess of the receiving tab's own, through `host.queries.setData`. It used to arrive as a canonical write, which restarted the receiving tab's stale clock, and `persistQueryCachePlugin` stored the guess. The peer's rollback removes it. A guess the peer says nothing more about for 30 seconds is rolled back, since a tab that closes mid-mutation never settles it.
  - A commit crosses, with `optimistic: true` and with `false`, and the receiving tab ends on the committed value without restarting its stale clock.
  - A peer's `replace` is applied as a `replace`, so it supersedes a fetch the receiving tab has in flight. It arrived as a patch, and an older response then overwrote the record the peer had replaced.
  - A canonical write made while the sender shows a guess carries the data beneath it, which the receiving tab writes as server truth. With `optimistic: false` the sender sends that data alone.
  - `SetDataMessage` gains `source` and `server`. A message without `source`, as versions before 1.0 send, is applied as a write. One with a source the tab does not know, or a malformed `server`, is dropped with a warning. The devtools lane shows each setData message's `source`.

## 1.0.0

### Major Changes

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
- cb08097: **Every shared query and every defined mutation is named by a required `id`. Plugin settings move to a typed `meta`. `mutate` and `createCache` fetchers receive `{ signal, deps }`.**
  
  ```ts
  const userQuery = defineQuery({
    id: 'users/detail', // was the optional `queryId`
    key: (id: string) => [id],
    fetcher: ({ signal, deps }, id) => deps.api.getUser(id, { signal }),
    meta: { crossTab: true }, // was `crossTab: true`
  })
  
  const createOrder = defineMutation({
    id: 'order/create', // was `mutationId`
    mutate: (vars: OrderInput, { signal, deps }) => deps.api.createOrder(vars, { signal }),
    meta: { persist: true }, // was the implicit default
  })
  
  const place = createMutation(ctx, createOrder, { onSuccess: () => toast('Placed') })
  ```
  
  - **`id` is required** on `defineQuery` and `defineInfiniteQuery`. An anonymous query was silently skipped by `dehydrate()`, by every plugin and by the devtools labels. Now every query is hydratable, pluggable and nameable. `defineMutation` requires `id` too. On an inline `createMutation` spec, `id` is optional and doubles as the devtools label, so `name` is gone.
  - **`meta` carries plugin settings.** `QueryMeta` and `MutationMeta` are empty interfaces that each plugin package augments. Installing `@kontsedal/olas-cross-tab` adds `meta.crossTab`, and `@kontsedal/olas-mutation-queue` adds `meta.persist`. Core no longer knows either name. `crossTab: 'data'` is gone; use `true`.
  - **`defineMutation` no longer persists by default.** Pass `meta: { persist: true }`. A definition describes only the write (`id`, `mutate`, `concurrency`, `retry`, `retryDelay`, `meta`). The owning controller adds lifecycle hooks with the new `createMutation(ctx, def, hooks)` overload, instead of spreading `{ ...def, onSuccess }`.
  - **`mutate(vars, { signal, deps })`** replaces `mutate(vars, signal)`, and `createCache(ctx, ({ signal, deps }) => …)` replaces `(signal) => …`. Query fetchers already received this context. A replayed mutation reaches its services through `deps` rather than a module-level import.
  - `ErrorContext.queryKey` becomes `queryId` + `key`. `MutationDisposedError.mutationName` becomes `mutationId`.
  - New exported types: `QueryMeta`, `MutationMeta`, `MutateCtx`, `MutationDefinition`, `MutationHooks`, `MutationRun`, `FetchCtx`, `InfiniteFetchCtx`, `LocalCacheOptions`.
- 2174dce: **Plugin host v2.** A plugin is a definition with a per-root `setup`, and it gets a host, typed events, middleware and a way to expose services.
  
  ```ts
  const logger = definePlugin({
    name: 'logger',
    setup(host) {
      return {
        onWrite: (e) => console.log(e.query.id, e.source, e.origin),
        wrapFetch: async (ctx, next) => {
          const t = performance.now()
          try {
            return await next()
          } finally {
            console.log(ctx.query.id, 'took', performance.now() - t)
          }
        },
      }
    },
  })
  
  createRoot(app, { deps, queries: queryEngine(), plugins: [logger] })
  ```
  
  **Core (`@kontsedal/olas-core`)**
  
  - **Definitions, not instances.** `setup(host)` runs once per root, in `plugins` order, before the root controller's factory. One plugin value can serve any number of roots. `QueryClientPlugin`, `QueryClientPluginApi` and their events are removed.
  - **The host** offers several things:
    - `deps`;
    - `provide(scope, value)`, a service a controller reads with `ctx.inject(scope)` and outside code reads with `root.inject(scope)`;
    - `reportError`, `onDispose`, and `track(promise)`, which makes `root.waitForIdle()` wait;
    - `network`, for online state and focus;
    - `queries` (`get`, `keys`, `peek`, `write`, `replace`, `invalidate`, `hydrate`, `dehydrate`, `hashKey`), addressed by query `id` and entry key;
    - `mutations` (`has`, `get`, and `run(id, vars)`, which runs a `defineMutation` through the engine's runner with its retry and the root's `deps`).
  - **Hooks:**
    - `onWrite` takes `source`: `'fetch'`, `'hydrate'`, `'optimistic'`, `'rollback'`, `'write'` or `'replace'`. It also carries `origin` and `updatedAt`.
    - The other observation hooks are `onInvalidate`, `onRemove`, `onActivate`/`onDeactivate` (an entry's first and last subscriber), and `onMutation` (every run of every mutation: `start`, then `success`, `error` or `cancel`).
    - Middleware: `wrapFetch` and `wrapMutate` wrap every attempt, with the first plugin outermost.
  - **Origins.** A write made through a plugin's host carries the plugin's name as `origin`. `bindQuery(ctx, query, { origin })` tags a handle's writes the same way. The client-wide `isRemote` flag is gone.
  - **Lifecycle:**
    - A `setup` throw aborts `createRoot`, after disposing the plugins already set up, in reverse.
    - No hook runs once the root starts disposing.
    - Plugins dispose in reverse order.
    - A hook throw reaches `onError` as `{ kind: 'plugin', pluginName }`, and the next plugin still runs.
    - Plugins work without a query engine; `host.queries` is then `null`.
  - **Fixed:**
    - Hydrating a bound entry reported two writes. It now reports one `'hydrate'` write.
    - A peer's invalidation refetched entries nobody subscribed to.
    - Hooks fired after `dispose()`.
    - The query registry was process-global. It is per root now, and a duplicate `id` warns when one root binds both queries.
  - **Other changes:**
    - `stableHash`, `lookupRegisteredQuery` and `lookupRegisteredMutation` leave the public surface.
    - Devtools `cache:*` events carry `queryId`, and `cache:set-data` uses the `WriteSource` vocabulary.
    - New `plugin:event` debug events come from `host.debug`.
  
  **`@kontsedal/olas-cross-tab`** mirrors only the app's own writes (origin `undefined`) by default. Other origins opt in through `origins`. New options: `optimistic: false` mirrors only canonical writes. The reuse guard is gone.
  
  **`@kontsedal/olas-entities`:** `entitiesPlugin({ entities: [Post, User] })` returns a plugin. The store is a per-root service: `ctx.inject(Entities)` / `root.inject(Entities)`. `entities.invalidate` is renamed `remove`, because it never refetched. Backprop writes carry the plugin's origin, so cross-tab no longer rebroadcasts N payloads per patch.
  
  **`@kontsedal/olas-mutation-queue`:**
  - `mutationQueuePlugin({ storage, keyPrefix })`; `adapter` is renamed `storage`.
  - Runs persist when `meta: { persist: true }`.
  - Replays go through the engine's runner: the definition's retry applies, `mutate` gets `deps`, and `waitForIdle()` sees them.
  - `replayNow()` is `ctx.inject(MutationQueue).replayNow()`.
  - `onReplaySettle(entry, result, queries)` receives the root's `QueryHost`.
  - The startup replay is tracked, so `root.waitForIdle()` waits for it.
  
  **`@kontsedal/olas-react`:** `createStreamingHydrator().plugin` is a v2 plugin. It captures committed writes only (fetch, write, replace) and uses each write's real `updatedAt`.

### Minor Changes

- b0f1c41: **Infinite queries reach parity with regular queries.**
  
  - **SSR.** `root.dehydrate()` includes infinite queries. A dehydrated entry for one carries its pages in `data` and one param per page in the new `pageParams` field. The client seeds the pages without refetching them and pages on from there. The streaming hydrator captures and delivers infinite queries too.
  - **Focus and reconnect.** `refetchOnWindowFocus` and `refetchOnReconnect` apply to infinite queries, on the query or as engine defaults. A refetch re-fetches every loaded page.
  - **Offline.** In `networkMode: 'offlineFirst'`, a network failure while offline parks an infinite query's fetch, including `fetchNextPage` and `fetchPreviousPage`, and retries it on reconnect, instead of surfacing an error. `isPaused` reports it.
  - **Cross-tab.** An infinite query with `meta: { crossTab: true }` syncs across tabs, its pages together with their params.
  - **Devtools.** Infinite queries show on the devtools timeline: fetch start and settle for each direction, and optimistic snapshot layers. The `cache:fetch-*` events carry `queryId` for every query.
  - **Plugins.** `WriteEvent` carries `pageParams` for an infinite query. `host.queries.write` and `replace` accept `{ pageParams }` (the new `WriteOptions` type).
- 439b8c2: **Cross-tab and entities report on their devtools lanes.** `@kontsedal/olas-devtools` shows one lane per plugin, and these two sent nothing on theirs.
  
  - **cross-tab** reports each message it posts and each message a peer sent. An event names the direction, the message type, the query and key, the sender's `sourceId` and `msgId`, and what became of it. A send is `posted` or `not-cloneable`. A receive is `applied`, `duplicate`, `malformed`, `ignored`, `rejected` or `failed`. The sender's id and `msgId` name one message in both tabs' lanes.
  - **entities** reports each `update`: the entity and id, how many query entries the patch reached and their query ids, and how many listed entries no longer held the entity.
  
  The events are development-only. cross-tab now ships a development build behind the `development` export condition, like core and entities, and its default build strips the calls. That build grew by 10 B, from 1.31 kB to 1.32 kB brotlied.
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

### Patch Changes

- fea5505: **Hover docs that described 0.8, or claimed what the code does not do, are corrected.** No behaviour changes.
  
  - **cross-tab:** `meta.crossTab` said infinite queries do not sync. They do, with their page params. The `origins` doc now says an `entities.update(...)` patch stays in its tab unless `origins` names the entities plugin. The clone note no longer says a class instance throws at `postMessage`: it arrives as a plain object.
  - **react:** the streaming examples rendered a `HydrationBoundary` on the server without a query engine. A server render runs no effects, so nothing disposes the boundary's root, and without an engine there is no cache to capture. They now build one root per request and render it through `OlasProvider`.
  - **mutation-queue:** the serialization notes said functions and symbols throw at enqueue. JSON drops them silently. A `BigInt` or a cycle is what throws.
  - **realtime:** a connection state with no reporter is `'unknown'`, not `'connected'`, and the composables are named `create*`.
  - **core:** `AsyncState` lists its ten signals, including `isEnabled`. `DehydratedEntry.id` no longer mentions anonymous queries. The subscription docs name `createQuery`, not `ctx.use`. `createSelection` cites SPEC §16.5.
  - **devtools:** the store's doc names `useValue`.
  - **core:** `DebugEventMeta.seq` no longer links a type that is not exported. `Form.submitError` no longer says a validation failure leaves it as it was: every `submit(...)` clears it first.
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- 4aa2542: **Security fix: cross-tab opens no channel on a server, and a forged message can no longer silence a peer.**
  
  - **The default channel factory opens a `BroadcastChannel` only in a browser tab or a web worker.** Node, Bun and Deno define `BroadcastChannel` too, and there it reaches every root in the process, and other worker threads or isolates. A server that built a root per request with `crossTabPlugin` opened a real channel per request, so one user's cache writes rendered in another user's response. On a server the plugin now installs no hooks. A `channelFactory` still opens a channel wherever it returns one: `channelFactory: (name) => new BroadcastChannel(name)`.
  - **A receiver moves a peer's `msgId` cursor only for a message it applied.** One malformed message carrying a real peer's `sourceId` and `msgId: Number.MAX_SAFE_INTEGER` used to silence that peer for good. A `msgId` 64 or more below the cursor now restarts it, so even a well-formed forged message stops mattering once the real peer speaks again.
- 5d58d4d: **A page element with the id `Bun` or `Deno` no longer turns cross-tab off.**
  
  HTML named access makes such an element a global of that name, and the default channel factory checked those names before the `document`. It now checks the `document` first.
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
