# @kontsedal/olas-react

## 1.0.1

### Patch Changes

- e5f9834: **An `<Activity>` above `HydrationBoundary` no longer throws its root away on hide.**
  
  React 19.2 runs a hidden `<Activity>` subtree's effect cleanups, and runs the effects again when it shows. The boundary disposed its root in that cleanup, so showing the subtree built a second root and lost what the user had typed. React cleans up an unmount the same way, and gives no signal that tells the two apart. The cleanup now suspends the root and disposes it a minute later, unless the boundary's effects run again first. A hide shorter than that keeps the root and its state. After a longer one, the boundary builds a fresh root from `options` when it shows.
  
  An unmount now disposes the root after that minute instead of at once, and the root stays suspended meanwhile. StrictMode's simulated unmount and remount keep one root, suspended and resumed, instead of disposing it and building another.
- e5f9834: **Streaming SSR hydrates without a mismatch: batches land where React never hydrates, and the boundary reads the ones already on the page.**
  
  `createStreamingTransform` wrote a batch at the end of any chunk that ended in text. React writes 2,048- or 4,096-byte chunks. A large shell put the `<script>` inside a list item's text, and a large `<Suspense>` segment put it inside `<div hidden id="S:0">`, which React's reveal moves into the boundary. Both broke hydration. The transform now writes a batch only directly inside `<body>` for a whole document, or at the top level for a fragment. The point must be outside every boundary's comments and right after a tag or a comment. The batch goes at the first such point in a chunk, so data goes out before the markup that reads it. A chunk with no such point holds the batch. A stream that ends inside markup gets no final batch.
  
  `HydrationBoundary` applied the streamed batches only in an effect after its first commit. So the hydrating render showed loading states where the server had rendered data, and each controller started the fetch the server had already made. The batches already on the page now go into the root's `hydrate` as the boundary builds it. A retry that reuses the root first applies the batches that arrived since, and later ones arrive through the intake as before.
  
  A root the boundary builds for a new `def` no longer receives the stream. Its intake used to replay every batch seen so far, which put the first tree's server rows over the new root's own fetch.
- e5f9834: **`useSuspenseQuery` no longer loops forever on a query that settled on `undefined`.**
  
  The hook suspended whenever `data` was `undefined`. A load can succeed with `undefined`: a `select` that reads an optional field, a fetcher that resolves nothing, an infinite query replaced with no pages. `firstValue()` resolved at once then, React retried, and the hook suspended again, thousands of times, starving the event loop. `useQuery(sub, { suspense: true })`, `useSuspenseQuery` and `useInfiniteQuery(sub, { suspense: true })` now suspend only until the first load settles, and return `undefined` as the value when it settled on that. A refetch over an `undefined` result does not suspend either.

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
- 1648b9a: **`HydrationBoundary`'s `options.deps` is checked against `AmbientDeps`,** as `createRoot`'s now are. `options` is typed `RootOptions<AmbientDeps>`, so in an app whose `AmbientDeps` names a service, `<HydrationBoundary options={{ deps: {} }}>` no longer compiles. Before, the prop took any object, and the missing service showed up at runtime.
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

### Minor Changes

- 360120c: **A development build behind a `development` export condition.** Devtools now work against the published packages.
  
  Until now, the release build inlined `__DEV__ = false`, so the core on npm emitted no devtools events at all. `@kontsedal/olas-devtools` showed an empty controller tree and timeline against it, and the dev-only warnings in core, entities, persist, react and zod never fired in an app.
  
  Each of these packages now ships two builds:
  - `dist/` is the default, a production build with every dev-only branch stripped;
  - `dist/dev/` sits behind the `development` condition, with the devtools events and the dev warnings kept.
  
  Vite's dev server, webpack and Rspack in development mode, and Next.js in dev resolve `development` without configuration, and their production builds resolve the default. With esbuild or Rollup, add `conditions: ['development']` to the dev config; in Node, `--conditions=development`. A browser with no bundler, or a CDN, gets the default build, as before.
  
  The production build is unchanged, and so are the bundle sizes. SPEC §23 has the details.
- 06b715f: **Vue and Svelte adapters; React gains `useInfiniteQuery`, a fine-grained `useQuery`, and verified Preact support.**
  
  **New: `@kontsedal/olas-vue`.**
  - `app.use(olasPlugin(root))` provides a root to the app, and `useRoot()` reads its api, typed through an augmented `Register`.
  - `useValue(signal)` returns a read-only ref over any `ReadSignal`. A read sees a write at once, and the subscription ends with the component's effect scope.
  - `useQuery`, `useInfiniteQuery`, `useField` and `useMutation` return one ref per signal plus the target's actions. `useField`'s `value` is writable, for `v-model`. `useMutation`'s `mutate` is fire-and-forget, and `run` returns the promise.
  
  **New: `@kontsedal/olas-svelte`.**
  - An Olas signal already satisfies Svelte's store contract, so `$count` works on a signal with no wrapper. A `Field` is a writable store, so `bind:value={$name}` writes through `field.set`.
  - `setRoot(root)` and `getRoot()` carry the root through Svelte context, typed through an augmented `Register`.
  - `queryStore`, `infiniteQueryStore`, `fieldStore` and `mutationStore` give one store per multi-signal object, with its actions.
  
  **react.**
  - New `useInfiniteQuery(subscription, { suspense? })`. One subscription covers `pages`, `flat`, the paging flags, `fetchNextPage` and `fetchPreviousPage`.
  - `useQuery` re-renders only for the fields a component reads. `const { data } = useQuery(sub)` no longer re-renders when a background refetch flips `isFetching`. A field read in an event handler or an effect returns its current value, and until anything is read, every change re-renders as before.
  - `useValue`'s `isEqual` now keeps the previous reference across an inline selector, which is a new function on every render.
  - The adapter runs under `preact/compat`. Alias `react` to it the way a Preact app does. The provider, every hook, `Suspense` and `SuspendOnUnmount` are tested there; `HydrationBoundary`'s StrictMode handling is not, because compat's `StrictMode` does nothing.
  
  One set of scenarios runs through React, `preact/compat`, Vue and Svelte, and each adapter renders the same DOM for it.
- b0f1c41: **Infinite queries reach parity with regular queries.**
  
  - **SSR.** `root.dehydrate()` includes infinite queries. A dehydrated entry for one carries its pages in `data` and one param per page in the new `pageParams` field. The client seeds the pages without refetching them and pages on from there. The streaming hydrator captures and delivers infinite queries too.
  - **Focus and reconnect.** `refetchOnWindowFocus` and `refetchOnReconnect` apply to infinite queries, on the query or as engine defaults. A refetch re-fetches every loaded page.
  - **Offline.** In `networkMode: 'offlineFirst'`, a network failure while offline parks an infinite query's fetch, including `fetchNextPage` and `fetchPreviousPage`, and retries it on reconnect, instead of surfacing an error. `isPaused` reports it.
  - **Cross-tab.** An infinite query with `meta: { crossTab: true }` syncs across tabs, its pages together with their params.
  - **Devtools.** Infinite queries show on the devtools timeline: fetch start and settle for each direction, and optimistic snapshot layers. The `cache:fetch-*` events carry `queryId` for every query.
  - **Plugins.** `WriteEvent` carries `pageParams` for an infinite query. `host.queries.write` and `replace` accept `{ pageParams }` (the new `WriteOptions` type).
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
- fea5505: **Hover docs that described 0.8, or claimed what the code does not do, are corrected.** No behaviour changes.
  
  - **cross-tab:** `meta.crossTab` said infinite queries do not sync. They do, with their page params. The `origins` doc now says an `entities.update(...)` patch stays in its tab unless `origins` names the entities plugin. The clone note no longer says a class instance throws at `postMessage`: it arrives as a plain object.
  - **react:** the streaming examples rendered a `HydrationBoundary` on the server without a query engine. A server render runs no effects, so nothing disposes the boundary's root, and without an engine there is no cache to capture. They now build one root per request and render it through `OlasProvider`.
  - **mutation-queue:** the serialization notes said functions and symbols throw at enqueue. JSON drops them silently. A `BigInt` or a cycle is what throws.
  - **realtime:** a connection state with no reporter is `'unknown'`, not `'connected'`, and the composables are named `create*`.
  - **core:** `AsyncState` lists its ten signals, including `isEnabled`. `DehydratedEntry.id` no longer mentions anonymous queries. The subscription docs name `createQuery`, not `ctx.use`. `createSelection` cites SPEC §16.5.
  - **devtools:** the store's doc names `useValue`.
  - **core:** `DebugEventMeta.seq` no longer links a type that is not exported. `Form.submitError` no longer says a validation failure leaves it as it was: every `submit(...)` clears it first.
- 254b79b: **`HydrationBoundary` no longer refetches forever when its parent re-creates it below an outer `<Suspense>`.**
  
  A retry of a discarded render found its root by the element's props object. A component below an outer `<Suspense>` that renders the boundary with inline options creates a new element on every retry, so each retry built a new root, refetched what the child suspended on, and suspended again. A retry now also reuses an unclaimed root built from the same `def`, the same `hydrate` object and `deps` with the same members. When those options change between attempts, the retry still builds a new root, and a development build warns once, naming the fix.
- 008d8ef: **A development build warns when `HydrationBoundary` renders on the server.**
  
  `HydrationBoundary` builds its root during render and disposes it in an effect cleanup. A server render runs no effects, so each request left a root alive, with its timers and plugins. The boundary now warns once per process when it renders without a `window`. The warning names the fix: on the server, create a root per request, render it through `<OlasProvider root={root}>`, and call `root.dispose()` after the response. Production builds carry no warning.
- da5829d: **A `<Suspense>` above `HydrationBoundary` no longer disposes the app root when it shows its fallback.**
  
  The boundary disposed its root in a layout-effect cleanup. React runs those cleanups when a Suspense boundary hides content it already showed, so a later suspension above the boundary, such as a `useSuspenseQuery` after a key change, disposed the live root, and the fallback stayed up. The dispose is a passive effect again, which a hide leaves alone.
  
  Two smaller changes to the same boundary:
  
  - a root that no commit claims and that never goes idle, such as one with a hung fetch, is disposed after a minute;
  - on the server, each render builds its own root. An element hoisted to module scope no longer hands one request's root to the next.
- affe2b0: **`HydrationBoundary` no longer leaks the root of a render that never commits.**
  
  The boundary builds its root during render, so its children can read hydrated data in the first render. Its effects dispose that root. A child that suspended or threw before the boundary's first commit made React discard the render, and no effect ran. The root stayed alive, with its fetches, timers and controller effects, and each retry built another one. A child calling `useSuspenseQuery` under a `<Suspense>` above the boundary never loaded: each retry's new root fetched again and suspended again.
  
  Now:
  
  - a retry of the same element reuses the root its earlier attempt built;
  - a root that no commit claims is disposed about ten seconds after its work goes idle;
  - a render for a new `def` no longer disposes the committed root, so a transition that suspends keeps the old tree working. The old root is disposed when the new one commits.
  
  A retry of an element that the parent re-created cannot find the earlier root, and builds a new one. Put a `<Suspense>` boundary inside `HydrationBoundary`, around the part that suspends.
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- 6a561d9: `useSuspendOnHidden` now resumes the controller when its effect goes.
  
  Unmounting a subtree while the tab was hidden left the controller suspended for good. The hook had suspended it, and its `visibilitychange` listener was the only thing that would resume it. That listener went with the same cleanup. Swapping the `controller` argument while hidden stranded the outgoing one the same way. The cleanup now resumes whichever controller it is the reason for suspending, and leaves a controller it never suspended alone.
  
  The package README's API table now covers every export, grouped by what it is for. It listed 8 of them before.
- 8791b0e: **A `useQuery` result read after commit stays live when React throws a later render away.**
  
  The fine-grained `useQuery` and `useInfiniteQuery` return getters that give the rendered snapshot during render and the live value afterwards. They told the two apart by a flag each render set and each commit cleared. A render that never commits, such as a transition whose sibling suspends, left the flag set. The committed result then kept returning its rendered values, so a field the component never read in render was read stale from an event handler or an effect. The hooks now count commits instead, and a discarded render cannot hold the count.
- 8791b0e: **`<SuspendOnUnmount>` and `useSuspendOnHidden` on one controller no longer undo each other.**
  
  Unmounting a wrapped subtree while the tab was hidden ran the wrapper's cleanup, which suspended the controller, and then the hook's cleanup, which resumed it. The unmounted screen's controller was left running. The two helpers now share one record of why each controller is suspended, and the controller resumes only when no reason is left. A wrapper that first mounts on a hidden tab waits for the tab to show. A tab that shows does not resume a controller whose last wrapper has unmounted.
- 02b45f2: Correct hover docs that described the wrong code, or showed an example that does not work.
  
  In core:
  
  - The `createField` example called `createField(ctx, '', { validators })`, which infers `Field<''>`, so the field's `set` then rejects every other string. The example now names the type, `createField<string>(...)`, as `API.md` does.
  - The `createFieldArray` example used a factory that ignored its argument, so `add('x')` built an empty field. The factory now uses its `initial`.
  - The `TimingSignal` doc sat above `TimingOptions`, so a hover on `TimingSignal` showed nothing. It is now on `TimingSignal`.
  
  In React:
  
  - The docs of `OlasProvider`, `createOlasContext`, `HydrationBoundary` and `SuspendOnUnmount` sat above their props types, so a hover on the component showed nothing. Each doc is now on its component.
  - The `HydrationBoundary` example passed `hydrate` without a query engine, so a development build warned and discarded the payload. It now passes `queries: queryEngine()`.
  
  No behavior changed.
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
