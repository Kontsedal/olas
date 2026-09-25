# @kontsedal/olas-core

## 1.0.0

### Major Changes

- f9b34a7: **The last API consistency pass before 1.0.**
  
  **core.**
  - `createField(ctx, initial, options?)` takes an options bag, `{ validators, validateOn }`, like `createForm` and `createFieldArray`. `FieldOptions` is exported. `npx @kontsedal/olas-codemod 1.0` rewrites the positional form.
  - `ctx.session` is removed. Use `ctx.attach(def, props)`, which returns `{ api, dispose, suspend, resume }`.
  - `root.suspend({ maxIdle })` is renamed `suspend({ maxIdleTime })`, and `SuspendOptions` is exported. Every duration is in milliseconds. Core's lifetime policies end in `Time` (`staleTime`, `gcTime`, `maxIdleTime`), and every other duration option ends in `Ms`.
  - `AsyncState` gains `isEnabled`, `false` while a subscription's `enabled` returns `false`, and always `true` for a local cache.
  - `refetch()` on a disabled subscription rejects with the new exported `QueryDisabledError`, which carries `queryId`. Before, it was an anonymous error you had to blanket-catch.
  - `firstValue()` on a disabled subscription waits until the subscription is enabled and loaded, instead of rejecting at once. It rejects on dispose. While pending it returns the same promise.
  
  **react.**
  - `useRoot()` is typed through a `Register` interface the app augments once, so call sites drop the type argument:
  
    ```ts
    declare module '@kontsedal/olas-react' {
      interface Register { root: typeof root }
    }
    ```
  - `useQuery` returns `isEnabled`.
  - `useQuery(sub, { suspense: true })` on a disabled query suspends until the query is enabled and loads, which is what a dependent query needs. Development builds warn once when it starts. Before, it re-threw an already-rejected promise and never resolved.
  - A `HydrationBoundary` whose `def` changes no longer re-hydrates the new root from the first root's server payload.
- 008d8ef: **`createRoot` checks `deps` against `AmbientDeps`.**
  
  `createRoot` inferred the type of `deps` from the object it was given, so `createRoot(app, { deps: {} })` compiled in an app whose `AmbientDeps` declares an `api`. The missing service showed up at runtime as `undefined`, and the docs advised `satisfies AmbientDeps` as a workaround. The type parameter is now `TDeps extends AmbientDeps`, so the compiler checks it:
  
  ```ts
  declare module '@kontsedal/olas-core' {
    interface AmbientDeps {
      api: ApiClient
    }
  }
  
  createRoot(app, { deps: {} })                     // error: `api` is missing
  createRoot(app, { deps: { api } })                // ok
  createRoot(app, { deps: { api, clock: Date.now } }) // ok: extra members are allowed
  ```
  
  A root that passes less than the app declared no longer compiles. Pass the missing service, or make it optional in the augmentation. `createTestController` does not check, so a test still passes only the fakes its controller reads.
- 1c6964e: **Breaking.** The lifetime-owned primitives are free functions that take `ctx` first, and a root that uses queries takes an explicit query engine. A controllers-only bundle built from the published `dist` is 5.9 KB gzipped. In 0.8 it was 19.9 KB.
  
  ```ts
  // 0.8
  const app = defineController((ctx) => {
    const email = ctx.field('')
    const user = ctx.use(userQuery, () => [id.value])
  })
  const root = createRoot(app, { deps })
  
  // 1.0
  import { createField, createQuery, queryEngine } from '@kontsedal/olas-core'
  
  const app = defineController((ctx) => {
    const email = createField(ctx, '')
    const user = createQuery(ctx, userQuery, () => [id.value])
  })
  const root = createRoot(app, { deps, queries: queryEngine() })
  ```
  
  | 0.8 | 1.0 |
  |---|---|
  | `ctx.field(...)` | `createField(ctx, ...)` |
  | `ctx.form(...)` | `createForm(ctx, ...)` |
  | `ctx.fieldArray(...)` | `createFieldArray(ctx, ...)` |
  | `ctx.cache(...)` | `createCache(ctx, ...)` |
  | `ctx.use(...)` | `createQuery(ctx, ...)` |
  | `ctx.mutation(...)` | `createMutation(ctx, ...)` |
  | `ctx.bindQuery(...)` | `bindQuery(ctx, ...)` |
  
  `ctx` keeps the members that bind to the controller's tree and lifetime: `emitter`, `child`, `attach`, `collection`, `lazyChild`, `effect`, `on`, `provide`, `inject`, `debug` and the lifecycle hooks.
  
  **A root whose controllers call `createQuery`, `createMutation` or `bindQuery` needs `queries: queryEngine()`.** Without an engine, those calls throw an error that names the fix. `createCache` needs no engine, because a controller-local cache is not a client entry. Forms, effects, children and emitters need none either. `createTestController` supplies an engine by default. Pass `queries: null` to test the no-engine path.
  
  **Why.** In 0.8, `Ctx` was one object with every method wired eagerly, in a module that `createRoot` imports. Every consumer shipped the forms subsystem and the query engine, whether or not the app had a field or a query. As named exports, a bundler drops the ones an app does not import. The query client is built in `query/engine.ts`, and nothing else imports it by value.
  
  The numbers come from `esbuild --bundle --minify` over `dist`, gzipped, with `@preact/signals-core` external. `pnpm size` checks per-entry budgets in CI. `.wiki/decisions/ctx-primitives-are-free-functions.md` has the reasoning, including the naming decision. `MIGRATING.md` and `npx @kontsedal/olas-codemod 1.0` cover the migration.
- 008d8ef: **Devtools: mutation events carry `id`, and `inspectorPollMs` is gone.**
  
  - **core:** the `mutation:run`, `mutation:success`, `mutation:error` and `mutation:rollback` events carried the mutation's `id` in a field named `name`. 1.0 removed `name` from mutations, so the event field now matches the spec field: `event.id`. It is absent for an inline `createMutation` spec without an `id`.
  - **devtools:** `MutationEntry.name` is now `MutationEntry.mutationId`. `MutationEntry.id` already numbers the log entry, so the mutation's own id takes the longer name. The panel shows and searches the same text as before.
  - **devtools:** the deprecated `DevtoolsPanelProps.inspectorPollMs` is removed. The panel ignored it: the cache inspector refreshes on every cache event, so there is no interval to set. Delete the prop.
- 518f5d9: **Query defaults live on the engine, and one engine can serve many roots.**
  
  ```ts
  createRoot(app, {
    deps,
    queries: queryEngine({ defaults: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } }),
    hydrate: window.__OLAS_STATE__,
    plugins: [crossTabPlugin({ channelName: 'app' })],
  })
  ```
  
  - **`queryEngine({ defaults })` is the one place for root-wide query defaults.** Before, focus refetch alone could be configured in five places, and `queryEngine`'s docstring disagreed with the code about which one won. The following are all removed:
    - `RootOptions.defaultQueryOptions`
    - the flat `RootOptions.refetchOnWindowFocus` / `refetchOnReconnect` shorthands
    - `QueryEngineOptions.defaultQueryOptions`, `plugins` and `hydrate`
  - **`hydrate` and `plugins` belong to the root.** They are per-instance: a payload for this render, installations for this root.
  - **An engine is a reusable definition.** It used to throw "already adopted" the second time a root took it. `HydrationBoundary` rebuilds its root from the same options under StrictMode and on a `def` change, so every StrictMode app that hydrated through it crashed. Each root now gets its own client from the same engine value, and it is safe to hoist one to module scope.
  - `DefaultQueryOptions` is renamed `QueryDefaults`.
  - `createTestController`'s `defaultQueryOptions` option is removed; pass `queries: queryEngine({ defaults })`.
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
- 3d95f3c: **`Form` and `FieldArray` are `ReadSignal`s of their value, like `Field`.** `form.value` is the form's value, not a signal holding it.
  
  ```ts
  // 0.8
  form.value.value
  use(form.value)
  form.value.subscribe(fn)
  
  // 1.0
  form.value
  useValue(form)
  form.subscribe(fn)
  ```
  
  The same holds for a `FieldArray`: `array.value` is the array of item values, and `array.items` still holds the item nodes.
  
  **`Form.resetWithInitial` is renamed `setAsInitial`**, matching `Field.setAsInitial`. `FieldArray` gains `set(values)` and `setAsInitial(values)`. `set` keeps the items at overlapping indices, so their touched state survives. `setAsInitial` rebuilds the items as a clean baseline that `reset()` returns to.
  
  **`Form.submit` resolves a `SubmitResult<R>` union.** Narrow on `ok`, then on `reason`:
  
  ```ts
  const result = await form.submit(save)
  if (result.ok) result.data
  else if (result.reason === 'error') result.error
  else result.reason // 'invalid' | 'busy' | 'disposed'
  ```
  
  Before, a submit that was already in flight and a disposed form both resolved `{ ok: false, error }`, and told apart only by the error message. `SubmitResult` and `SubmitOptions` are exported.
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
- a29b4ea: **The React hooks, renamed and completed; the aliases are gone.**
  
  **react.**
  - `use(signal)` is renamed `useValue(signal)`. `use` shadowed React 19's `React.use`, which takes a promise or a context.
  - `useMutation` returns `mutate` and `run`. `mutate(vars)` returns nothing and is the call for an event handler: a failure lands on `error`, `status` and `onError`, and never becomes an unhandled rejection. `run(vars)` returns the run's promise, and the caller owns the rejection. `mutateAsync` is removed. The result also carries `status`.
  - An aborted run no longer fires `useMutation`'s `onError` or `onSettled`. That covers a superseded `latest-wins` run, `reset()` and dispose. The mutation's own hooks in core already skipped aborts.
  - `useQuery` returns every `AsyncState` value, now including `isPaused`, plus `reset` and `cancel` beside `refetch`.
  - `useField` adds `setAsInitial`. Its actions, and `useMutation`'s, keep their identity across renders.
  - The result types are exported: `UseQueryResult`, `UseSuspenseQueryResult`, `UseFieldResult`, `UseFieldInputResult`, `UseMutationResult`, `UseMutationCallbacks` and `MutateFn`.
  - `KeepAlive` is removed. Use `SuspendOnUnmount`, which it aliased.
  
  **core.**
  - `AsyncState.promise()` is removed. Use `firstValue()`, which it aliased.
  - `AsyncState` gains `cancel()`, so a `LocalCache` can abort its in-flight fetch the way a query subscription could.
  - `ctx.signal` and `ctx.computed` are removed. Import `signal` and `computed`, which they re-exported.
  - `selection()` is renamed `createSelection()`, like the rest of the `create*` family.
  - `UseOptions` is renamed `QuerySubscriptionOptions`.
  
  `npx @kontsedal/olas-codemod 1.0` rewrites the `use` and `KeepAlive` imports and their references, `mutateAsync` → `run`, and every awaited `mutate(...)` → `run(...)`.
- 20473ba: **The root is a handle, and your api lives on `root.api`.**
  
  ```ts
  const root = createRoot(app, { deps, queries: queryEngine() })
  root.api.increment()  // was root.increment()
  root.dispose()
  ```
  
  Before 1.0, `createRoot` returned the controller's api with the root controls mixed in. That reserved eight names in every app's namespace: `dispose`, `suspend`, `resume`, `bindQuery`, `dehydrate`, `waitForIdle`, `applyDehydratedEntry` and `__debug`. An api using one of them threw at startup. It also meant any root control added later would break someone. Now the api and the controls never share a namespace:
  
  - A controller may return anything, including a primitive, and members named `dispose` or `suspend`.
  - `root.inject(scope)` is new. It resolves a scope as the root controller would.
  - `root.hydrate(state)` replaces `root.applyDehydratedEntry(id, key, data, lastUpdatedAt)`. It takes a whole `DehydratedState`.
  - `root.debug` replaces `root.__debug`. The devtools components take `root: Pick<Root, 'debug'>`.
  - `createTestController` returns the same handle (`const { api } = createTestController(def, { deps })`). `props` may be omitted for a controller that takes none, and the helper accepts `plugins`, `scopes` and `hydrate`.
  - In `@kontsedal/olas-react`, `useRoot()` and `createOlasContext().useRoot()` still return the api. `useController(root)` is removed: it was an identity function, and `root.api` says the same thing.
- 4c47f81: **Brands are symbol keys, and `InfiniteQuery` gains `peek`, `write` and `replace`.**
  
  **Brands.** Public values no longer carry `__olas`, `__t`, `__types`, `__id`, `__options` or `__create`. A value's kind, its phantom type slot and the engine's plumbing now live under symbol keys that core does not export. They stay out of autocomplete, `Object.keys` and `JSON.stringify`. This affects `ControllerDef`, `Query`, `InfiniteQuery`, `QueryEngine`, `Scope`, the `defineMutation` result, and entities' `EntityDef`.
  
  The keys are `Symbol.for` symbols, so two copies of core in one bundle still recognize each other's values. Code that read `query.__olas` to tell a query from an infinite query should keep a reference to the definition instead.
  
  `Scope` loses `__id`. A scope object is its own identity.
  
  **`InfiniteQuery.peek`, `write` and `replace`** match `Query`'s:
  - `peek(...args)` reads the loaded pages without creating an entry or subscribing.
  - `write(...args, updater)` is a canonical patch. It pushes no snapshot and leaves an in-flight fetch alone.
  - `replace(...args, pages)` takes whole pages and cancels the in-flight fetch.
  
  The bound handles from `bindQuery` and `root.bindQuery` carry the same three methods.

### Minor Changes

- 360120c: **A development build behind a `development` export condition.** Devtools now work against the published packages.
  
  Until now, the release build inlined `__DEV__ = false`, so the core on npm emitted no devtools events at all. `@kontsedal/olas-devtools` showed an empty controller tree and timeline against it, and the dev-only warnings in core, entities, persist, react and zod never fired in an app.
  
  Each of these packages now ships two builds:
  - `dist/` is the default, a production build with every dev-only branch stripped;
  - `dist/dev/` sits behind the `development` condition, with the devtools events and the dev warnings kept.
  
  Vite's dev server, webpack and Rspack in development mode, and Next.js in dev resolve `development` without configuration, and their production builds resolve the default. With esbuild or Rollup, add `conditions: ['development']` to the dev config; in Node, `--conditions=development`. A browser with no bundler, or a CDN, gets the default build, as before.
  
  The production build is unchanged, and so are the bundle sizes. SPEC §23 has the details.
- a2b8b14: The panel scales to a long session: bounded memory, windowed views, one search box and a lane
  per plugin.
  
  - **Ring buffer.** The timeline keeps the newest 10,000 events and counts the ones it
    overwrote. The count shows in the timeline's toolbar, and Clear resets it. The new
    `maxTimelineEntries` prop on `DevtoolsPanel` and `DevtoolsLauncher` sets the capacity, and
    `DevtoolsStore.droppedEvents$` exposes the count. The cache, mutation and field logs use the
    same ring at their `maxEntries` cap.
  - **Windowed views.** The timeline, the tree and the four log lists mount only the rows in
    view. A row keeps its expanded state when it scrolls away. The tree renders as flat rows with
    `aria-level` and a collapse chevron per parent. An open cause-group shows 100 events at a
    time, with a button for the rest.
  - **Keyed tree.** Applying an event costs constant time plus the path depth. The old tree
    scanned siblings on every event and walked the whole tree on every dispose. Unchanged
    subtrees keep their object identity between `tree$` reads.
  - **Disposed controllers.** They stay in the tree, greyed, up to `maxDisposedNodes`, and their
    `ctx.debug` values freeze at dispose time. `ControllerNode.disposedAt` records when. Pruning
    now drops the earliest-disposed subtree first rather than the earliest-constructed one.
  - **Omnibox.** A search box above the tabs, focused with `/`, finds controllers, query ids,
    key args, mutations, form fields and payload content. Results are grouped by kind, and Enter
    jumps to the row and highlights it. The index is built on the first search after a change,
    so typing does not re-stringify anything. `DevtoolsStore.search()` is the same search
    without the UI.
  - **Plugin lanes.** An event a plugin publishes through `host.debug` is badged with the
    plugin's name, and a chip per lane shows or hides that lane's events.
  - **URL hash hardening.** With `urlHashKey`, the panel now validates the state it reads from
    the hash. A crafted link with a non-string filter used to throw during render and unmount the
    whole host app. An unknown tab, a non-string filter or a non-object value now falls back to
    the defaults (W15 security review, L7).
  - **Smaller stylesheet.** The build minifies the inline CSS, which saves 2.1 KB brotli.
  
  Type changes: `DevtoolsStore`'s `tree$`, `cache$`, `mutations$`, `fields$` and `events$` are
  `ReadSignal`s. The store derives them from its rings and its tree, so there was nothing a
  caller could usefully write. The default for the `maxTimelineEntries` store option rises from
  500 to 10,000.
  
  **core: `DebugCacheEntry` carries its `queryId`.** `root.debug.queryEntries()` identified an entry by its key alone, so two queries holding entries under the same key looked like one in the panel: one label, duplicate list keys, and a shared diff baseline. The panel now identifies an entry by its query id and key.
- 325ecf3: **The devtools see who subscribes to each cache entry.**
  
  - **core.** A `createQuery` subscription sends `cache:subscribed` when it binds an entry and the new `cache:unsubscribed` when it lets go, on subscribe, key change, disable, suspend, resume and dispose. Both carry `queryId`, `queryKey` and the subscribing controller's path. `DebugCacheEntry` gains `subscribers`, the count of subscriptions holding the entry, which `root.debug.queryEntries()` always sets. `cache:subscribed` was declared before and never sent.
  - **core.** A plugin's `host.queries.invalidate` sends `cache:invalidated`, as an app's `invalidate` does, so a plugin's invalidation shows on the timeline.
  - **devtools.** `DevtoolsStore.subscribers$` counts the subscriptions per entry from those events, re-seeded from each `queryEntries()` snapshot so a panel attached late counts them too. The inspector shows the count on each entry, and the cache log renders `unsubscribed` rows.
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
- b0f1c41: **Infinite queries reach parity with regular queries.**
  
  - **SSR.** `root.dehydrate()` includes infinite queries. A dehydrated entry for one carries its pages in `data` and one param per page in the new `pageParams` field. The client seeds the pages without refetching them and pages on from there. The streaming hydrator captures and delivers infinite queries too.
  - **Focus and reconnect.** `refetchOnWindowFocus` and `refetchOnReconnect` apply to infinite queries, on the query or as engine defaults. A refetch re-fetches every loaded page.
  - **Offline.** In `networkMode: 'offlineFirst'`, a network failure while offline parks an infinite query's fetch, including `fetchNextPage` and `fetchPreviousPage`, and retries it on reconnect, instead of surfacing an error. `isPaused` reports it.
  - **Cross-tab.** An infinite query with `meta: { crossTab: true }` syncs across tabs, its pages together with their params.
  - **Devtools.** Infinite queries show on the devtools timeline: fetch start and settle for each direction, and optimistic snapshot layers. The `cache:fetch-*` events carry `queryId` for every query.
  - **Plugins.** `WriteEvent` carries `pageParams` for an infinite query. `host.queries.write` and `replace` accept `{ pageParams }` (the new `WriteOptions` type).
- 325ecf3: **`createCache` gains the canonical writes, and `waitForIdle()` counts it.**
  
  - `LocalCache` has `write(updater)` and `replace(value)`, with `Query`'s semantics. `write` patches without a snapshot and leaves a fetch in flight alone. `replace` sets the whole record and supersedes a fetch in flight. Before, a canonical patch to a local cache was `setData(…).finalize()`, and a forgotten `finalize()` left `hasPendingMutations` true for good.
  - `root.waitForIdle()` waits for `createCache` fetches, on a root with or without a query engine. SSR code no longer needs to await `cache.firstValue()` for each local cache.
- a328f3a: **The mutation queue no longer replays a run the app dropped, and no longer loses a `serial` queue on reload.**
  
  - **New: `reason` on a `'cancel'` mutation event.** It is `'superseded'` for a `latest-wins` run a newer run replaced, `'reset'` for a run `reset()` dropped, and `'dispose'` when the controller that owned the run was disposed. The first two are the app discarding the run on purpose. `'dispose'` only means the screen is gone.
  - **New: a `'queued'` mutation event.** A `serial` run that waits behind another reports `'queued'` when `run(...)` is called, under the `runId` it keeps, and `'start'` when its turn comes. A queued run that never starts still reports one outcome: `'cancel'` when `reset()` or a dispose drops it, or `'error'` when its `onMutate` throws. A plugin that treats every phase other than `'start'` as a settle should handle `'queued'` first.
  - **A superseded or reset run is no longer replayed.** The queue kept the entry of every cancelled run, on the premise that a reload mid-run looks like a cancel. It does not: plugin delivery closes before a root disposes, and an unload emits nothing. The cancels the queue saw were supersedes and resets. An autosave with `latest-wins` and `persist: true` left each superseded draft on disk, and the next reconnect, `replayNow()` or page load sent it after the newer draft had landed. The queue now deletes the entry on `'superseded'` and `'reset'`, and keeps it on `'dispose'`.
  - **Runs queued behind a hanging request survive a reload.** The queue wrote an entry when a run started, and a queued `serial` run started only when the run ahead of it settled. When the first request hung or backed off, storage held that request alone. The queue now writes each run when it is queued, in call order.
  - **A replay releases the dedupe key of the entry it drops.** After an in-session failure was replayed, the `dedupeBy` key still pointed at the deleted entry. The next run with that key collapsed onto it, wrote no entry, and was lost on a reload.
- 8aaf0e7: **Devtools hears a cancelled mutation run as `mutation:cancel`.**
  
  A superseded, reset or disposed run sent plugins a `'cancel'` and sent devtools nothing. A panel then paired the next settle with the wrong start. `DebugEvent` gains `{ type: 'mutation:cancel'; path; id?; reason: 'superseded' | 'reset' | 'dispose' }`. Dev builds send it for every run whose plugin event is `'cancel'`, with the same `reason` and the run id as `causeId`. A queued `serial` run dropped before it started sends one too, with no `mutation:run` before it.
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
- 6caffb5: **`retry: false` is accepted, and means never retry.** The spec allowed `retry: false`, but `RetryPolicy` had no `false`, and a JS caller passing it got "retry is not a function" reported as the fetch failure. `RetryPolicy` now includes `false`, and queries, infinite queries and root defaults treat it as `0`.
- 1299818: **Cache identity and root isolation.**
  
  - **`bindQuery(ctx, query)` and `root.bindQuery(query)` scope query operations to one root.** They cover regular and infinite queries. With more than one root, an unbound helper such as `userQuery.invalidate(...)` throws. In 0.8 it broadcast writes to every root or read an arbitrary root's data. A bound `prefetch` works before anything subscribes. A bound operation rejects after its root is disposed.
  - **Cache keys encode every value with a type tag.** A special value can no longer collide with a user's string or object. Special values include `undefined`, `NaN`, a `Date` and a `bigint`. Any hash an app stored outside the process must be rebuilt.
  - **`-0` in a cache key is `0`.** Arithmetic produces `-0`, every equality callers use treats it as `0`, and JSON, the SSR transport, cannot represent it. Keeping it distinct split entries and broke hydration.
  - **One expiry scheduler runs every duration:** staleness, gc, `refetchInterval`, the `retryDelay` backoff and `suspend({ maxIdleTime })`. `staleTime: Infinity` and `gcTime: Infinity` schedule no timer. A finite delay above the platform's 32-bit timer limit is split into chunks. In 0.8, each of these clamped to about 1 ms. The longest settings then behaved as the shortest: a cache stale on arrival, an entry collected on the next tick, or a poll storm.
  - **mutation-queue:** a replay's invalidation reaches only the root the plugin is installed on.
  
  Unbound `query.peek()` throws under multiple roots, where 0.8 neither threw nor warned. Check hot-path `peek` call sites when upgrading. `MIGRATING.md` covers the migration.
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

- beab02a: **A failing sync validator no longer leaves an unhandled rejection behind.** A field, form or field array called its sync and async validators in one pass. When a sync one failed, the pass ended before the async ones settled, and the next pass or dispose aborted them with no handler attached. Clearing a field that had `required` and a `debouncedValidator` put an unhandled `AbortError` in the console. The pass now aborts the async validators it walks away from and observes their rejections, which also stops their requests early. A validator already known to be async is no longer called at all when a sync one fails; the entry on validator order has the rule.
- d5642d5: Three fixes in the query engine and `createSelection`.
  
  - **A fetcher that rejects with its own `AbortError` left an infinite query fetching.** This release fixes the same defect for regular queries, and it lived in both of `InfiniteEntry`'s loops too. The request now settles as a failure: `status: 'error'`, the error on `error`, and `isFetching`, `isLoading` and the page-direction flag cleared. Loaded pages are kept. `root.waitForIdle()` now resolves after it. A superseded request still writes nothing.
  - **`keepDataWhileDisabled` did nothing on an infinite query.** `createQuery(ctx, infiniteQuery, { enabled, keepDataWhileDisabled: true })` accepted the option and ignored it. Disabling now keeps the loaded `pages`, `data` and `flat`, as it does for a regular query. `flat` also follows retained pages under `keepPreviousData`; before, it went empty while `pages` still showed the previous key's data.
  - **`createSelection().isSelected(id)` minted a new signal on every call.** A row rendering `useValue(sel.isSelected(id))` then re-subscribed on every render. The same id now returns the same signal while anything holds it. The cache holds them weakly, so a long list scrolled end to end does not pin one per row.
- ae18408: Three correctness fixes in the query engine: a `serial` mutation that ran two writes at once after `reset()`, a query stuck fetching, and structural sharing corrupting a payload's prototype.
  
  - **`reset()` on a `serial` mutation let the next two runs overlap.** `reset()` aborts the active run and unlocks the queue, so the next `run(...)` opens a new one. The abandoned run's continuation still fired when its abort landed, and it advanced whatever queue it found. Start A, `reset()`, start B, queue C: A's abort started C alongside the pending B, and B's completion then cleared the lock while C was still running. Serial mutations exist to keep writes ordered, so this was a lost-update generator one `reset()` away. Continuations now carry the queue they belong to, and a stale one does nothing. `dispose()`, `detached: true` and the rejection of queued runs are unchanged.
  
  - **A fetcher that rejects with its own `AbortError` left the query fetching.** Every cancellation the engine performs marks the request superseded first: a newer fetch, `cancel()`, hydration, dispose. The old code read *any* `AbortError` as one of those, rethrowing it, writing nothing, and leaving the newer request to settle the entry. When the abort came from the fetcher instead there was no newer request, so `isFetching` stayed `true`. A fetcher aborts itself through an `AbortSignal.timeout`, an axios cancel token, or a rethrown stale abort. The result was a spinner that ran until the entry was disposed, `root.waitForIdle()` that did not resolve during SSR, and `firstValue()` that did not settle under Suspense. Such a request now settles as a failure: `status: 'error'`, the error on `error`, the in-flight flags cleared, `data` kept. A superseded request still writes nothing, so it cannot clear a newer request's state.
  
  - **Structural sharing mishandled an own `__proto__` property.** `JSON.parse('{"__proto__":{…},"value":1}')` produces an own, enumerable `__proto__`. Rebuilding that object with `out[key] = value` hits `Object.prototype`'s accessor, which replaced the result's prototype and created no property. The shared value came back without the key, wearing a prototype the payload supplied. Its own data then read through the prototype chain of a value every subscriber sees. Keys are written with `defineProperty` now, and presence is tested with `Object.hasOwn` rather than `in`. A rebuilt object also keeps the prototype both sides shared, so an `Object.create(null)` payload no longer comes back wearing `Object.prototype`. Reference sharing for unchanged subtrees is unaffected.
  
  Also reconciles `writeData`'s comment, which claimed both that a canonical write supersedes an in-flight fetch and that it does not. It does not. 0.7.2 rolled that behaviour back into `replace(...)` and left the old paragraph standing above the new one. No behaviour change: the code matched SPEC §5.5 throughout.
- 008d8ef: **A `ctx.debug(...)` call while suspended reaches the devtools on resume.**
  
  A suspended controller stored the new values but sent no event, so the panel showed the old variables until the next `ctx.debug` call after resume. `resume()` now sends one `controller:debug` event with the merged values, after `controller:resumed`. A controller that called nothing while suspended sends nothing extra.
- 153261f: **Fixes found by the 1.0 coverage pass and mutation testing.**
  
  - **zod: initial values now match what Zod parses.**
    - A `.default()` under `.optional()` or `.nullable()` seeds its field. Before, the field started empty.
    - A function-valued default seeds the function. Before, it seeded the function's result, because Zod 4 had already run the default factory once.
    - A numeric enum seeds its first option, where it seeded `''`.
  - **realtime:** `createLiveStream({ rafFlush: true })` without `requestAnimationFrame` (Node, SSR) started a timer per event and cancelled only the last on dispose, so events flushed after the stream was disposed. Events in one tick now share one timer.
  - **entities:** `entities.update(Post, id, { author: newUser })` now normalizes the nested entity the patch brings in, and the query's bindings follow the patch. Before, the new author never reached the store, and a later update of the replaced author overwrote the new one inside the query.
  - **mutation-queue:** `dispose()` now wakes a replay that is waiting out a backoff, so the tab releases the cross-tab replay lock at once instead of up to `maxBackoffMs` later.
  - **core: a form's `isValid` no longer flickers during async validation.** While anything in a form or field array validates, its `isValid` holds the last settled answer, as a field's already did (spec §8.2). Before, a form read invalid for the whole of any child's async check, so a bound submit button flickered.
  - **core: hydration and canonical writes rebase pending optimistic snapshots everywhere.**
    - `root.hydrate` over an entry with a pending optimistic update now re-points the update's rollback at the hydrated data, as a fetch success does. Before, the rollback restored the pre-hydration value.
    - An infinite query's `write` / `replace` (and the plugin and cross-tab writes that share them) now survive a pending optimistic update's rollback. Before, the rollback undid them.
  - **core: infinite paging flags follow the request that owns the entry.**
    - A superseded page request no longer clears `isFetchingNextPage` / `isFetchingPreviousPage` for a newer request of the same direction, which also broke the de-duplication of a third call.
    - A refetch clears both flags, so a fetcher that ignores its abort signal no longer leaves one stuck and `fetchPreviousPage()` silently doing nothing.
  - **core: a mutation that fails just as it is aborted reports `'error'` to plugins, and its caller gets an `AbortError`.**
    - This is the twin of the specified late-success case. Before, plugins heard `'cancel'`, so the mutation queue kept the entry without counting the attempt, while the run promise rejected with the real error.
    - A mutation disposed mid-run now goes to `status: 'idle'`, where it stayed `'pending'`.
  - **core: `dispose()` or `reset()` called from inside `onMutate` cancels the run.** The optimistic write rolls back and `mutate` never runs. Before, `mutate` ran anyway with a signal that never fired, plugins heard `'success'`, and `status` stayed `'pending'`.
  - **core: an `AbortError` that `mutate` throws itself is a failure.** When the run's own signal is still live, the abort came from the work (a request it cancelled on its own). The run now goes to `status: 'error'`, calls `onError`, rolls back, and reports `'error'` to plugins. Before, it counted as a cancellation: `status` stayed `'pending'`, and the mutation queue kept the entry to replay.
  - **core: a lifecycle handler that changes the controller's state ends the pass that called it.** An `onResume` handler that disposed or re-suspended the controller left its effects running. An `onSuspend` handler that disposed it let the remaining `onSuspend` handlers fire.
  - **core: an `online` event that arrives while `navigator.onLine` still reads false no longer spins.** A parked query checks once, parks again, and waits for the next event. Focus and reconnect subscribers follow the DOM's dispatch rules: one added during a dispatch waits for the next event, and one removed before its turn is skipped.
  - **core: an outdated fetch's error is dropped for its caller too (spec §5.6).** A fetch that a newer one superseded already wrote nothing. It now also rejects with an `AbortError`, as an outdated fetch that succeeds does. Before, the stale error reached `onError` through `invalidate()`, and a `prefetch()` rejected with it instead of resolving with the value that won.
  - **core: an infinite query's `isLoading` clears when a page request takes over.** A write that landed during the first load, followed by `fetchNextPage()`, left `isLoading` true for good: the page request superseded the first load, and its success never cleared the flag.
  - **core: a `prefetch()` in flight when the root is disposed no longer arms a gc timer afterwards.** The timer held a Node process open for `gcTime`.
  - **core: `serial` mode: `root.waitForIdle()` waits for queued runs.** It could resolve while a queued run was about to start, so SSR's `waitForIdle → dehydrate` missed that run's writes.
  - **core: `resume()` honours an `enabled` that turned false while suspended.** The subscription goes disabled: `isEnabled` false, `status: 'idle'`, and `refetch()` rejects with `QueryDisabledError`.
  - **core:** an infinite query without `itemsOf` keeps `flat` equal to `pages` while retained pages show (spec §5.11). It returned `[]`.
  - **core:** `root.hydrate` drops a payload of another `version` with a warning, as `createRoot({ hydrate })` and `host.queries.hydrate` already did.
  - **core: `FieldArray.remove` / `move` with an out-of-range index, or `move` to the same index, no longer mark the array dirty.** They changed nothing, and the dirty flag stopped a reactive `initial` from re-applying.
  - **core: a rejected async form-level or array-level validator is an error.** A field already reported a rejection's message; a form or array ignored it and read valid.
  - **devtools:**
    - The Tree tab's controller count now shows; it always computed 0.
    - A mutation's settle no longer clears another mutation's pending badge.
    - Switching tabs no longer applies the previous tab's filter for the length of the debounce.
    - The floating launcher renders when reading `localStorage` throws, in a sandboxed iframe or with site data blocked.
- 372b013: **Children built in unusual moments behave: under a suspended parent, inside an effect, or while the parent disposes.**
  
  - A child built while its parent was suspended started active inside the frozen tree. That happened for a `lazyChild` load that settled during a suspension, and for `ctx.child` or `ctx.attach` called from a `ctx.on` handler. The child now starts suspended, and the parent's next resume wakes it.
  - `ctx.child` and `ctx.attach` ran the child's factory inside the caller's tracking scope. An effect that attached a modal whose factory read `user.value` re-ran whenever `user` changed, disposing the modal and its draft. The factory now runs untracked, as `ctx.collection`'s already did.
  - A child whose construction disposed the parent was pushed into the dead parent's cleared list, and its `onDispose` hooks never ran. It is now disposed with the parent.
  - An effect registered after construction whose first run disposed its controller kept running for the rest of the program. It is now stopped, and one whose first run suspends its controller waits for the resume.
- 372b013: **A field array that churns rows no longer grows its controller.**
  
  An item built with `createField(ctx, …)`, `createForm(ctx, …)` or `createFieldArray(ctx, …)` registers teardown on the controller. `remove`, `clear`, `set` and `reset` disposed the item but kept that registration. A hundred add and remove cycles left a hundred entries, and the root's dispose called each dropped item's `dispose` again. A disposed field, form or field array now drops its own registration.
- 372b013: **A reactive `initial()` keeps edits made while it loads, and its throws reach `onError`.**
  
  The first defined value `initial()` returned seated the form even when the form was already dirty. Data that loaded after the user started typing therefore overwrote the edit, under the default `resetOnInitialChange: 'when-clean'` too. The first value now keeps every edit; the entry on the first `initial()` value has the per-field rule. `'never'` seats the form once, from the first defined value or from a `reset()` that seats one.
  
  A throw from `initial()` escaped into whatever wrote the signal it read. A refetch whose data changed shape rejected with the form's `TypeError`, and the query showed `status: 'error'` while holding the new data. The throw now reaches the root's `onError` as `kind: 'effect'`, as a validator throw does, and the form keeps its values.
- 372b013: **A plain `root.suspend()` keeps an armed `maxIdleTime`, and a failed bootstrap tears down in the dispose order.**
  
  A second `suspend()` without `maxIdleTime` cancelled the auto-dispose a first `suspend({ maxIdleTime })` had armed. A visibility hook that suspended an already-suspended root thereby lifted the memory bound. A plain `suspend()` now leaves the timer running, and a `suspend({ maxIdleTime })` still restarts it.
  
  When the root factory threw, `createRoot` disposed the plugins and the query client without closing them first. Plugins heard the rollback's events, such as a query entry deactivating. Delivery now closes before the rollback, as it does in `root.dispose()`.
- 372b013: **Two form-level validators that target one field no longer erase each other's message.**
  
  Every form routing issues onto a field wrote one shared list. An inner form's rule and an outer form's rule can both target the same field. Fixing the outer rule cleared the list, and the inner rule's still-failing message vanished: the field read `errors: []` and `isValid: true`. Each routing form now keeps its own list on the target, and the field shows them merged.
- 372b013: **A programmatic selection change ends the shift-click run.**
  
  A run of shift-clicks computes each range against the selection as it stood before the run began. Only a plain or meta click ended the run, so the second shift-click undid a `toggle`, `select`, `deselect`, `clear` or `selectAll` made in between. Click a, shift-click c, `toggle('z')`, shift-click y selected `{a, y, z}` and dropped b and c. Every programmatic change now ends the run.
- 372b013: **Async validators start only after every sync validator passes, as SPEC §8.1 says.**
  
  A pass called every validator and only then looked at the results, so `[required(), checkUsername]` sent `checkUsername('')` to the server. A pass now runs the sync validators first and does not call the async ones when a sync one fails. A pass cannot tell a sync validator from an async one before calling it. A validator therefore counts as async when it is declared `async`, or once it has returned a promise. The same order applies to form-level and array-level validators.
- 372b013: **`fakeField` and `fakeAsyncState` behave like the real ones.**
  
  A `fakeField` read `isValid: false` while `isValidating`, where a real field holds its settled validity. Its `reset()` restored only the value, `setErrors` overwrote the seeded errors, and `set()` neither updated `isDirty` nor cleared server errors. It now acts as a field with no validators. `setErrors` writes a separate server channel that `set()` clears, `set()` compares against the initial value for `isDirty`, and `reset()` clears dirty, touched and every error.
  
  A `fakeAsyncState` given an `error` now has status `'error'`. Its `firstValue()` resolves with the data when there is any, as a real subscription does, and otherwise rejects with the error. A `'pending'` status reads as fetching, and as loading while there is no data. With no data, `firstValue()` stays pending, as a real subscription waits, instead of resolving `undefined`.
- 372b013: **A check in flight ends with its field: dispose settles it, and reset drops its result.**
  
  Disposing a field, form or field array during an async validation left `isValidating` stuck at `true`, so a `revalidate()`, `validate()` or `submit()` waiting on it never resolved. Removing a row from a field array mid-submit therefore hung the submission: `isSubmitting` stayed `true`, and every later `submit()` returned `{ ok: false, reason: 'busy' }`. `dispose()` now ends the pass. A submission over the remaining rows completes, and a form disposed while it validates resolves `{ ok: false, reason: 'disposed' }` without calling the handler.
  
  `reset()` also drops a check still in flight. A validator that ignores its `AbortSignal` could land its result on the reset field, so a `validateOn: 'submit'` field showed `['taken']` after `revalidate()` and `reset()`.
- cdb6b77: **An effect that ends its controller on resume stops, and primitives disposed early leave the controller.**
  
  A resume re-runs each effect. When that run disposed or suspended the controller, as `ctx.effect(() => { if (session.expired.value) root.dispose() })` does after the session expired during a suspension, the effect kept running. It ran on after the dispose, or inside the suspended tree. The effect now stops with the controller, and after a suspend it re-runs on the next resume. This covers a collection's reconcile and a child an `attach` handle resumes.
  
  A `createCache` cache, a `createMutation` mutation and a `ctx.emitter()` emitter disposed early kept their entry on the controller, and the cache stayed in the root's set for `waitForIdle()`. A controller that churned them, as the Map pattern in SPEC §3.4 does, grew without limit and disposed each one again at its own dispose. Each now drops its entry when it disposes, as a field, form and field array already did.
- cdb6b77: **The first `initial()` value fills the fields the user has not edited.**
  
  The dirty guard on a reactive `initial()` covered the first defined value as a whole. One edit made before the data loaded therefore kept every other field at its empty seed. A keystroke in one field blocked the whole seat. So did a default the factory set with `form.set(...)`, or a `FieldArray` row added before `createForm`. A save then wrote blanks over the record. The first value now seats every leaf the user has not edited. An edited field keeps its value, and the loaded value becomes its baseline, so `isDirty` and `reset()` compare against it. A changed `FieldArray` keeps its rows the same way and stays dirty. Later values keep the form-wide guard.
  
  `reset()` now reads `initial()` untracked. A `reset()` inside an effect no longer subscribes that effect to what the thunk reads. A throw from the thunk reaches `onError` as the reactive seat's does, instead of the caller. A `reset()` that seats a defined value counts as the one seat `resetOnInitialChange: 'never'` allows, so a later value no longer re-seats the form.
- cdb6b77: **`fakeAsyncState().firstValue()` checks data first, and every `deselect` ends a shift-click run.**
  
  A `fakeAsyncState` given both `data` and an `error` rejected `firstValue()` with the error. A real subscription resolves with the data it kept through a failed refetch, and the fake now does the same.
  
  `selection.deselect(id)` for an id that was not selected left a shift-click run going, where every other programmatic call ends it. The next shift-click then computed its range against the stale snapshot. It now ends the run too.
- 008d8ef: **A reset no longer hides a form-level rule that still fails.**
  
  `field.reset()` and `field.setAsInitial()` cleared the messages a form-level validator had routed onto the field, and `form.reset()` cleared the form's `topLevelErrors`. When the reset left the form's value unchanged, the validator did not re-run, so the messages stayed gone and `form.isValid` read `true` until the next edit. `submit()` was safe, because it validates first.
  
  The form-level run is now the only writer of those messages. A reset that changes the form's value re-runs the validators, which recompute them, and a reset that does not leaves their last result on screen. Validator errors and server errors still clear on `reset()`, as before. Nothing starts a new async run: a no-op reset during one leaves it to settle.
- cdb6b77: **A `null` for a nested form or field array no longer throws.**
  
  `form.set({ address: null })` threw on `Object.entries(null)`, and so did `setAsInitial` and the first seat of a reactive `initial()` when an API record held `null` for a nested object. A nested form or field array now treats `null` as it treats `undefined`: it keeps its current state. A field still takes `null` as its value.
- fea5505: **Hover docs that described 0.8, or claimed what the code does not do, are corrected.** No behaviour changes.
  
  - **cross-tab:** `meta.crossTab` said infinite queries do not sync. They do, with their page params. The `origins` doc now says an `entities.update(...)` patch stays in its tab unless `origins` names the entities plugin. The clone note no longer says a class instance throws at `postMessage`: it arrives as a plain object.
  - **react:** the streaming examples rendered a `HydrationBoundary` on the server without a query engine. A server render runs no effects, so nothing disposes the boundary's root, and without an engine there is no cache to capture. They now build one root per request and render it through `OlasProvider`.
  - **mutation-queue:** the serialization notes said functions and symbols throw at enqueue. JSON drops them silently. A `BigInt` or a cycle is what throws.
  - **realtime:** a connection state with no reporter is `'unknown'`, not `'connected'`, and the composables are named `create*`.
  - **core:** `AsyncState` lists its ten signals, including `isEnabled`. `DehydratedEntry.id` no longer mentions anonymous queries. The subscription docs name `createQuery`, not `ctx.use`. `createSelection` cites SPEC §16.5.
  - **devtools:** the store's doc names `useValue`.
  - **core:** `DebugEventMeta.seq` no longer links a type that is not exported. `Form.submitError` no longer says a validation failure leaves it as it was: every `submit(...)` clears it first.
- a328f3a: **`retry: false` on a mutation never retries, as SPEC §5.2 says.**
  
  The mutation runner called any `retry` that was not a number, so `retry: false` failed the run with "retry is not a function". The error `mutate` threw was lost, and `onError` and the `error` signal received the `TypeError`. The runner now calls only a function `retry`. A number caps the attempts, and anything else means no retry.
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- 023eaf3: **An optimistic write no longer makes stale data look fresh.**
  
  An optimistic `setData` moved `lastUpdatedAt`, and the subscribe-time staleness check read it. Past `staleTime`, a new subscriber then skipped its refetch while the write was live, after it rolled back, and after it was finalized. After a rollback it showed old server data as fresh. The `isStale` signal read `true` all along, so the signal and the refetch decision disagreed.
  
  Staleness now counts from the last fetch, hydrated row or canonical `write` or `replace`, for regular and infinite queries. A subscriber, `resume()`, focus or reconnect refetch or `prefetch` that finds the entry stale while an optimistic write is live starts no fetch, since the response would land over the guess. The entry runs that fetch once the last live write settles, if something still holds it. The decision waits one microtask, so an `invalidate()` in `onSuccess` or `onSettled` makes the only request. `lastUpdatedAt` still moves on an optimistic write. `isStale` now restarts its timer on a canonical write and on an infinite query's page fetch, which the refetch decision already counted as fresh.
- 6caffb5: **Binding a bigint-keyed query twice no longer crashes a development build.** The warning for a second bind with diverging call args printed the key with `JSON.stringify`, which throws on a bigint, so `createRoot` threw in development. The key now prints with a bigint written as `1n`. The check also compared call args by identity, and warned on equal args built afresh on every re-key. It now compares them by value.
- 6caffb5: **`firstValue()` resolves at once when the entry holds data.** A background refetch sets `status: 'pending'` over data, and `firstValue()` waited for it instead of resolving with the data on hand, as its documentation says it does. It now resolves at once whenever data is present, a failed background refetch included. A subscription's `refetch()` that a newer fetch supersedes still settles with that newer fetch. The docs no longer claim `status` stays `'success'` during a background refetch: it reads `'pending'` while the data stays.
- 6caffb5: **Live hydration skips rows older than the entry, and a future timestamp counts as now.** A streamed or persisted row stamped before an entry's `lastUpdatedAt` reverted newer client data and moved `lastUpdatedAt` back. Such a row is now skipped, and plugins hear no write for it. A payload stamped ahead of the client's clock read `isStale` with `staleTime: 0` yet never refetched, and stayed fresh past `staleTime`. A future stamp is now read as the client's now.
- 6caffb5: **An invalidation is no longer lost to a fetch that started before it.** With no subscribers, `invalidate` only marks an entry stale. A released entry keeps its fetch running for the gc window, and that older response used to clear the mark when it landed, so the next subscriber skipped the refetch. With `staleTime: Infinity` the pre-invalidation data stayed for good. The mark now holds until data requested after it lands: a fetch that started after the invalidation, or a hydrated row stamped after it. Hydration follows the same rule for regular and infinite entries; it used to clear the mark for infinite entries only.
- 6caffb5: **Dehydrated keys now survive the JSON trip to the client.** `dehydrate` ships raw key args, and a key that JSON rewrites hashed differently after the trip, so the client never adopted the entry: it mounted `pending` and refetched, a hydration mismatch in React. A persisted cache had the same problem. A key now hashes as the value JSON round-trips it to. An `undefined` object member counts as absent, `undefined` in an array and a non-finite number as `null`, and a Date as its ISO string. `{ q: undefined }` and `{}` therefore name one cache entry, as a Date and its ISO string do. Every other value keeps its type tag.
- 6caffb5: **`keepPreviousData` no longer shows another key's data on a disabled subscription.** A subscription that moved from key `a` to `b` and was then disabled read `a`'s data instead of `undefined`, and a re-enable on a new key bridged with `a` instead of `b`. `keepPreviousData` now covers key changes only, and `keepDataWhileDisabled` alone covers the disabled gap. The data on screen at the disable becomes the bridge for the next key. The same holds for infinite queries.
- 6caffb5: **A fetch requested offline supersedes the one in flight, and reconnect makes one request.** In `online` mode, a fetch requested while offline parked without superseding the fetch already running, so that older response still landed: a local cache whose key changed offline showed the old key's data. It now supersedes it first, as a request made online does. An interval tick or a focus or reconnect refetch now skips an entry whose fetch is parked. Each tick used to park one more waiter, and with `refetchOnReconnect` one `online` event started two requests and aborted the first.
- 6caffb5: **`prefetch` settles when its fetch is cancelled, and `prefetchInfinite` joins a fetch in flight.** A `cancel()` on an entry without data left a pending `prefetch` waiting forever, holding the entry: it was never gc'd, and `invalidate` refetched it as if subscribed. The prefetch now rejects with an `AbortError` when a cancel leaves no data, and resolves with the data a cancel keeps. A prefetch that joins a fetch in flight settles with that fetch, not with the stale data it replaces. `prefetch` on an infinite query now joins a request in flight instead of restarting it, and a supersede resolves it with the eventual result instead of rejecting.
- 6caffb5: **`resume()` no longer aborts a fetch already in flight.** A suspend and resume during a first fetch aborted it and fetched again. `resume()` now joins a running fetch, as a subscribing effect does, for regular and infinite queries.
- 6caffb5: **`debounced` and `throttled` schedule through the shared expiry scheduler.** Their windows used a raw `setTimeout`, which fires a non-finite delay after about a millisecond and overflows one past the 32-bit limit, so `debounced(source, Infinity)` emitted almost at once. A window of `Infinity` now never fires on its own, and `flush()` still emits. A finite window past the limit waits its full length.
- 3f9b98d: **The diverging call args warning fires when only the key hash makes two args equal.**
  
  Keys hash as JSON round-trips them, so `{ max: Infinity }` and `{ max: -Infinity }` share one entry. The development warning for a second bind with other call args compared the args by the same hash, so it stayed silent there, and the fetcher kept the first bind's args unannounced. Call args now compare structurally, with no JSON normalization. A `Date` compares by its time, and a cyclic arg no longer warns by mistake.
- 3f9b98d: **`dehydrate()` keeps an entry that holds data during a refetch or after a failed one.**
  
  `dehydrate()` serialized only entries at `status: 'success'`. `status` reads `'pending'` over the data during a background refetch, and `'error'` over it after a failed one. A dehydrate at either moment, such as a persisted cache saving on a write, dropped an entry that held data. It now serializes every entry that holds data, stamped with the time that data was written.
- 3f9b98d: **Live hydration compares a row against the server data, not against an optimistic write.**
  
  `root.hydrate` skipped a row stamped before the entry's `lastUpdatedAt`, which an optimistic `setData` also moves. A newer server row was then dropped after an optimistic write and its rollback, and during a pending mutation. The row is now compared against the time of the entry's last fetch, hydrated row or canonical write. A row that arrives during an optimistic write becomes the rollback baseline, as a fetch result does.
  
  A row for a key nothing has bound waits in a buffer. The buffer took every row as it came, so an older row replaced a newer one and the first bind showed the older data. It now keeps the newest row per key.
- 3f9b98d: **A subscriber that joins a fetch older than an invalidation still gets a refetch.**
  
  An invalidation of an entry with no subscribers only marks it stale, and the next subscriber refetches. A subscriber that came back while a fetch requested before the invalidation was still running joined that fetch instead. The older response kept the stale mark, but nothing fetched again, even with `staleTime: Infinity`. `resume()`, `prefetch` and infinite queries did the same, and a `prefetch` resolved with the older data. Now, when data lands and leaves the stale mark standing, an entry with a subscriber or a prefetch holding it fetches once more. `isFetching` stays true between the two requests, and a joined `prefetch` resolves with the fresh data. A page from `fetchNextPage` or `fetchPreviousPage` on a stale entry counts too.
  
  A hydrated row stamped before an invalidation had the same gap. It superseded the refetch the invalidation started and left the entry stale, with nothing fetching. A subscribed entry now fetches once more there as well.
- 3f9b98d: **A local cache's `firstValue()` waits for the new key after a key change.**
  
  With `keepPreviousData`, a `createCache` local cache keeps the previous key's data on screen after its key changes. `firstValue()` resolved with that data at once, so a navigation guard read the wrong record. It now settles with the fetch for the new key, as a shared query's subscription does.
- 3f9b98d: **A fetch parked for the network runs once the network is back, even when the `online` event is missed.**
  
  The interval, focus and reconnect triggers skipped a parked entry and left it to the `online` event. A worker has no `window` to fire that event, and a browser can fire it while `navigator.onLine` still reads false, so the entry stayed parked with `isPaused: true` for good. These triggers now run the parked fetch when they find the network back. While offline they still start nothing, and one `online` event still makes one request.
- 3f9b98d: **An infinite query's `prefetch` requested offline resolves with the first page.**
  
  A fetch requested offline parks until reconnect. For an infinite query, the reconnect drain resolved the parked request with no value, so `prefetch` resolved `undefined`. It now resolves with the first page, as it does online. The `offlineFirst` park gets the same fix.
- 3f9b98d: **`debounced` and `throttled` with a `NaN` window emit again.**
  
  The shared timer scheduler creates no timer for a non-finite delay, `NaN` included. A `NaN` window, such as a failed `Number(...)` parse, therefore never emitted, where it used to fire at once. It now runs as `0`, with a development warning.
- 325ecf3: **Five query-engine fixes.**
  
  - **A `replace` that discards an invalidation's refetch now catches up.** A reconnect's `invalidateAll()` refetches to reconcile what the app missed. A push folded in with `replace` while that refetch was in flight discarded the response and carried only its own record, so the missed data never arrived and the entry stayed stale with nothing to refetch it. The entry now fetches once more when an invalidation marked it stale and it still has subscribers. A `replace` during that catch-up leaves it in flight, so a burst of pushes cannot keep it from landing. `await invalidate()` resolves when the catch-up settles, and a failed catch-up reaches `onError`.
  - **A `retry` or `retryDelay` callback that throws no longer wedges `isFetching`.** The throw escaped the retry loop: the fetch rejected while `status` stayed `'pending'` and `isFetching` stayed `true`, so `waitForIdle()` and `firstValue()` hung. The throw now fails that attempt with the thrown error, for regular and infinite queries and for infinite page requests. The mutation runner was not affected.
  - **`ErrorContext.attempt` and `cause` are set.** No call site set them before. A failed fetch an invalidation reports now carries `attempt`, the 0-based attempt that failed last, and `cause`, the fetch error a throwing retry callback replaced.
  - **An infinite query's optimistic snapshots rebase on a successful fetch**, as a regular query's do. A rollback after `fetchNextPage` restored the pages from before the fetch and dropped the appended page. It now keeps the page and drops only the optimistic change, after a refetch and `fetchPreviousPage` as well.
  - **`host.queries.replace` has one rule for both query kinds.** On an infinite query it cancelled a fetch in flight even for empty pages. Every `replace` path, app-side and plugin, now supersedes only when the write leaves the entry holding data.
- 3f9b98d: **A `retryDelay` of `NaN` retries at once instead of hanging.**
  
  The retry sleep read a `NaN` delay as "never", as it reads `Infinity`. A query or mutation whose `retryDelay` computed `NaN` then sat at `isFetching: true` or `isPending: true` with no retry, until something aborted it. A `NaN` delay now means "retry now".
- 38cf416: **Faster teardown and refetch, found by the new benchmark baselines.**
  
  - **A settled request lets go of its `AbortController`.** A query kept its last request's controller until the next refetch, hydration, cancel or dispose aborted it. That aborted nothing, but each `abort()` built a `DOMException`, and on Node that was half the CPU time of a root with 1,000 queries. It also fired the finished request's `signal` late, so an `abort` listener a fetcher left behind ran long after its request was over. A fetcher's `signal` now stays un-aborted once its request has settled.
  - **`root.dispose()` no longer arms a gc timer per query.** Disposing the controllers released each subscription, and each release armed a gc timer the query client cleared a moment later. A root with 1,000 queries now disposes in 0.37 ms, down from 6.9 ms.
- 02b45f2: Correct hover docs that described the wrong code, or showed an example that does not work.
  
  In core:
  
  - The `createField` example called `createField(ctx, '', { validators })`, which infers `Field<''>`, so the field's `set` then rejects every other string. The example now names the type, `createField<string>(...)`, as `API.md` does.
  - The `createFieldArray` example used a factory that ignored its argument, so `add('x')` built an empty field. The factory now uses its `initial`.
  - The `TimingSignal` doc sat above `TimingOptions`, so a hover on `TimingSignal` showed nothing. It is now on `TimingSignal`.
  
  In React:
  
  - The docs of `OlasProvider`, `createOlasContext`, `HydrationBoundary` and `SuspendOnUnmount` sat above their props types, so a hover on the component showed nothing. Each doc is now on its component.
  - The `HydrationBoundary` example passed `hydrate` without a query engine, so a development build warned and discarded the payload. It now passes `queries: queryEngine()`.
  
  No behavior changed.

## 0.8.0

### Minor Changes

- **Mutations: `detached: true`, a typed post-dispose rejection, and a completed run is no longer rolled back.**

  Three fixes and one new option, all in how a mutation behaves when the controller that owns it goes away.

  - **New: `ctx.mutation({ detached: true })` (SPEC §6.5).** `dispose()` stops cancelling — in-flight runs finish, queued `serial` runs drain, `run(...)` still works afterwards, and `onSuccess` / `onError` / `onSettled` still fire, so the invalidation that usually hangs off `onSuccess` lands instead of being skipped. The default is right for a read a closing screen no longer wants; it is wrong for a write, whose request is already at the server. `reset()` and a `latest-wins` supersede still cancel — those are the app saying "drop this one", where dispose only says "this screen is gone".

  - **Breaking-ish: `run()` after dispose now rejects with `MutationDisposedError`**, exported from `@kontsedal/olas-core` and carrying `mutationName` + `controllerPath`. It was a bare `Error('Mutation disposed')`, which `isAbortError()` did not match and nothing identified — so a caller filtering cancellations correctly still surfaced the raw message to a user, and one filtering broadly lost the write in silence. It is deliberately **not** an `AbortError`: a run that was never accepted is not a cancellation. If you match on the message, match on the type instead.

  - **Fixed: a run whose `mutate` already resolved is no longer rolled back.** When the abort landed in the gap before the run's continuation, the optimistic snapshot was rolled back — committing a value already known to be stale to a cache that outlives the mutation, with the `onSuccess` that would have invalidated it skipped. It finalizes now. The promise still rejects with `AbortError`.

  - **Fixed: that same run no longer settles as `'cancelled'`.** `@kontsedal/olas-mutation-queue` reads `'cancelled'` as "keep the durable entry and replay on next load", so a `persist: true` write the server had accepted was queued for a second attempt. It settles `'success'`.

  Also corrects SPEC §4, which described teardown as "children → caches/effects → `onDispose` hooks". It is one reverse-registration pass over all entry kinds, so whether an `onDispose` hook can still reach an effect depends on which was created first — see the new `.wiki/pitfalls/dispose-order-is-registration-order.md`.

## 0.7.2

### Patch Changes

- e8933dd: **`query.replace(...keyArgs, value)` — a canonical write that supersedes an in-flight fetch — and `query.write(...)` goes back to leaving fetches alone.**

  0.7.0 and 0.7.1 made `write` itself supersede. That is right for a whole record and wrong for a patch, and `write` cannot tell which it is being given: an updater reading `prev` describes the fields it touches and says nothing about the rest, so a response already on its way may be carrying newer values for them. Discarding it loses those. A downstream app folded a one-field push into a cached record while a refetch was outstanding, the refetch was discarded, and the field it would have brought never arrived — twice, in two unrelated suites, intermittently, because it is a race.

  The distinction cannot be recovered inside the entry, because the updater's output looks identical either way. So it moves into the signature:

  ```ts
  // A patch. Says nothing about the other fields, so an outstanding request still lands.
  tabQuery.write(id, (prev) => ({ ...prev, title }));

  // The whole record, as the server last stated it. An older request has nothing to add.
  tabQuery.replace(id, tabFromServerPush);
  ```

  - **`replace`** takes a value, not an updater — that is the claim that licenses superseding. It supersedes only when `value` is defined (replacing with `undefined` says "no record", and cancelling as well would strand the entry at `success` over no data).
  - **`write`** is unchanged from 0.6.0 in this respect: it does not supersede. `cancel(...)` first is still the escape hatch when a caller has decided a patch should win.
  - **`setData`** is untouched: an optimistic guess, which a server response may overrule (SPEC §5.5).

  Kept from 0.7.x, both real fixes: a canonical write **rebases live optimistic snapshots** onto the written value, so a rollback restores that rather than an older baseline; and `prefetch()` **recovers from a supersede** the way `subscription.refetch()` has since T3.9, resolving with the entry's eventual value instead of rejecting with `AbortError`.

  Released as a PATCH on the 0.7 line rather than a minor, deliberately: 0.7.0 and 0.7.1 carry the broken supersede, and anyone on `^0.7.0` should pick this up automatically. A 0.8.0 would strand them on the bug.

  **Migration from 0.6.x**: none required. From 0.7.0/0.7.1: any `write` you were relying on to supersede becomes `replace` — the two seams that want it are typically a server push carrying a full record, and a just-created record returned by its own mutation.

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
