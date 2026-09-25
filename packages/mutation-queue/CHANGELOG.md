# @kontsedal/olas-mutation-queue

## 1.0.1

### Patch Changes

- e5f9834: **A replay keeps the order of a mutation id, keeps a newer draft, and leaves another tab's live runs alone.**
  
  - An entry that stays on disk ends its group's replay pass: a failure worth a retry, or a run executing it. The group's later entries wait for the next pass. A later draft used to reach the server first, and the next pass sent the older draft after it.
  - A success deletes a `dedupeBy` entry only when no newer run's variables ride on it. A replay whose entry a collapse rewrote while it was sending keeps the entry, in this tab or when the key belongs to another tab. A live run's success hands the entry to a newer run collapsed onto it that is still sending. Either success used to delete the newer draft, so a failure of that draft left nothing for the next load.
  - A live run marks its entry as its tab's until it settles, with a Web Lock, or a `localStorage` lease a heartbeat refreshes where Web Locks is missing. A replay pass in another tab skips a marked entry. The replay lock covered replays only, so a pass used to send a request another tab still had out. A closed tab's locks are released and a lease without a heartbeat expires after 30 seconds, so a dead tab's entries still replay.
  - A `localStorage` lease dated more than 30 seconds in the future no longer counts as held. Such a lease, which only other code writing to storage can leave, used to block every replay pass for good.
  - The devtools lane reports `in-other-tab` for an entry a run in another tab marked, and `waiting` for each entry a group leaves behind a kept one.

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
- 9ed7356: **`isRetryable`, a devtools lane, and one replay order for every tab.**
  
  - **New: `isRetryable(err, entry)`.** The queue treated every failure as transient, so a 422 that fails the same way on every load spent all `maxAttempts` before `onReplayError` fired. With `backoffMs` set, that took several page loads. Return `false` from `isRetryable` and the queue drops the entry at once and reports it through `onReplayError`. It asks about a live run's failure and a replay's. `mutate` is the app's own function, so the queue cannot read a status code itself: throw an error that carries one, and read it in `isRetryable`. The README has an example. A throw from `isRetryable` is reported through `onWarn`, and the entry stays. Without the option nothing changes.
  - **Replays show on the devtools lane.** The queue sends each replay attempt, its result, and each entry a pass skipped through `host.debug`. A payload carries the entry's `mutationId` and `runId`, the attempt number, and the result or skip reason. The package now ships a development build behind the `development` export condition, like core, and only that build has this code. The production build and its size are unchanged.
  - **Two tabs no longer replay tied entries in storage order.** `seq` is seeded from `Date.now()`, so two tabs that open in the same millisecond give unrelated entries the same `seq`. The replay order of those entries was the order the storage listed its keys, which differs between adapters and can differ between tabs. `runId` now breaks the tie. Every stored entry carries one, so entries written by earlier versions sort the same way, and the stored format is unchanged.
- 1299818: **Cache identity and root isolation.**
  
  - **`bindQuery(ctx, query)` and `root.bindQuery(query)` scope query operations to one root.** They cover regular and infinite queries. With more than one root, an unbound helper such as `userQuery.invalidate(...)` throws. In 0.8 it broadcast writes to every root or read an arbitrary root's data. A bound `prefetch` works before anything subscribes. A bound operation rejects after its root is disposed.
  - **Cache keys encode every value with a type tag.** A special value can no longer collide with a user's string or object. Special values include `undefined`, `NaN`, a `Date` and a `bigint`. Any hash an app stored outside the process must be rebuilt.
  - **`-0` in a cache key is `0`.** Arithmetic produces `-0`, every equality callers use treats it as `0`, and JSON, the SSR transport, cannot represent it. Keeping it distinct split entries and broke hydration.
  - **One expiry scheduler runs every duration:** staleness, gc, `refetchInterval`, the `retryDelay` backoff and `suspend({ maxIdleTime })`. `staleTime: Infinity` and `gcTime: Infinity` schedule no timer. A finite delay above the platform's 32-bit timer limit is split into chunks. In 0.8, each of these clamped to about 1 ms. The longest settings then behaved as the shortest: a cache stale on arrival, an entry collected on the next tick, or a poll storm.
  - **mutation-queue:** a replay's invalidation reaches only the root the plugin is installed on.
  
  Unbound `query.peek()` throws under multiple roots, where 0.8 neither threw nor warned. Check hot-path `peek` call sites when upgrading. `MIGRATING.md` covers the migration.

### Patch Changes

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
- fea5505: **Hover docs that described 0.8, or claimed what the code does not do, are corrected.** No behaviour changes.
  
  - **cross-tab:** `meta.crossTab` said infinite queries do not sync. They do, with their page params. The `origins` doc now says an `entities.update(...)` patch stays in its tab unless `origins` names the entities plugin. The clone note no longer says a class instance throws at `postMessage`: it arrives as a plain object.
  - **react:** the streaming examples rendered a `HydrationBoundary` on the server without a query engine. A server render runs no effects, so nothing disposes the boundary's root, and without an engine there is no cache to capture. They now build one root per request and render it through `OlasProvider`.
  - **mutation-queue:** the serialization notes said functions and symbols throw at enqueue. JSON drops them silently. A `BigInt` or a cycle is what throws.
  - **realtime:** a connection state with no reporter is `'unknown'`, not `'connected'`, and the composables are named `create*`.
  - **core:** `AsyncState` lists its ten signals, including `isEnabled`. `DehydratedEntry.id` no longer mentions anonymous queries. The subscription docs name `createQuery`, not `ctx.use`. `createSelection` cites SPEC §16.5.
  - **devtools:** the store's doc names `useValue`.
  - **core:** `DebugEventMeta.seq` no longer links a type that is not exported. `Form.submitError` no longer says a validation failure leaves it as it was: every `submit(...)` clears it first.
- a328f3a: **The mutation queue no longer replays a run the app dropped, and no longer loses a `serial` queue on reload.**
  
  - **New: `reason` on a `'cancel'` mutation event.** It is `'superseded'` for a `latest-wins` run a newer run replaced, `'reset'` for a run `reset()` dropped, and `'dispose'` when the controller that owned the run was disposed. The first two are the app discarding the run on purpose. `'dispose'` only means the screen is gone.
  - **New: a `'queued'` mutation event.** A `serial` run that waits behind another reports `'queued'` when `run(...)` is called, under the `runId` it keeps, and `'start'` when its turn comes. A queued run that never starts still reports one outcome: `'cancel'` when `reset()` or a dispose drops it, or `'error'` when its `onMutate` throws. A plugin that treats every phase other than `'start'` as a settle should handle `'queued'` first.
  - **A superseded or reset run is no longer replayed.** The queue kept the entry of every cancelled run, on the premise that a reload mid-run looks like a cancel. It does not: plugin delivery closes before a root disposes, and an unload emits nothing. The cancels the queue saw were supersedes and resets. An autosave with `latest-wins` and `persist: true` left each superseded draft on disk, and the next reconnect, `replayNow()` or page load sent it after the newer draft had landed. The queue now deletes the entry on `'superseded'` and `'reset'`, and keeps it on `'dispose'`.
  - **Runs queued behind a hanging request survive a reload.** The queue wrote an entry when a run started, and a queued `serial` run started only when the run ahead of it settled. When the first request hung or backed off, storage held that request alone. The queue now writes each run when it is queued, in call order.
  - **A replay releases the dedupe key of the entry it drops.** After an in-session failure was replayed, the `dedupeBy` key still pointed at the deleted entry. The next run with that key collapsed onto it, wrote no entry, and was lost on a reload.
- 8aaf0e7: **`dedupeBy` no longer loses a queued `serial` run or replays a superseded draft, and a run superseded during a slow write sends nothing.**
  
  - A queued `serial` run with the same `dedupeBy` key as the run ahead of it collapsed onto that run's entry. The run ahead settled first and took the entry with it, so the queued run went out with nothing on disk. A reload lost it, and a dispose replayed only the first run. A queued run now writes an entry of its own.
  - A `latest-wins` run superseded by one with the same key kept its entry for the successor, with its own older variables. A dispose, a retryable failure or a reload then replayed the stale draft. The entry now takes the newest collapsed run's variables once its owner settles. A run that collapses onto an entry kept after a dispose or a retryable failure rewrites it before its request goes out. With `dedupeBy`, a success under the key also drops the entries disposed runs left under it.
  - On an async storage, a run superseded while its entry was being written still called `mutate` once the write landed. A `mutate` that ignores its signal sent the stale request. The queue now skips the call.
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- 6a561d9: Stop the queue from replaying a write the server already took.
  
  - **A manual retry no longer leaves a second entry.** A failed run keeps its durable entry so the next page load can replay it. The user presses the button again instead of waiting. That retry is a new `runId`, so its success dropped only its own entry, and the next load replayed the first one and wrote twice. A run that succeeds now also drops the entries left by earlier runs of the same logical operation that settled in error. Identity is `dedupeBy(mutationId, variables)` when configured, otherwise the mutation's `id` plus the JSON form of the variables. Runs still executing keep their own entry, and a `cancelled` run keeps its own as before.
  - **A `dedupeBy` collapse now settles the entry it collapsed onto.** The collapsed run wrote no entry. Its settle therefore deleted a key that never existed, and left the owner's entry on disk to replay a write the collapse had already landed.
  - **A replay pass skips runs executing in this tab.** A run's entry is on disk for the whole window between its enqueue and its settle. An `online` event or a `replayNow()` landing in that window found the entry and fired the same request again. Cross-tab overlap is unchanged: the replay lock and the server's idempotency key still cover it.
  - **Disposing the root releases a pass parked on the offline wait.** A tab that disposed while offline held the cross-tab replay lock. It also leaked the `online` listener the wait had registered. Both survived until a network that may never return.
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
- Updated dependencies [6a561d9]
- Updated dependencies [9ed7356]
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
- Updated dependencies [4aa2542]
- Updated dependencies [5d58d4d]
- Updated dependencies [38cf416]
- Updated dependencies [4c47f81]
- Updated dependencies [38cf416]
- Updated dependencies [02b45f2]
  - @kontsedal/olas-core@1.0.0
  - @kontsedal/olas-persist@1.0.0

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
  - @kontsedal/olas-persist@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [eb859d9]
  - @kontsedal/olas-core@0.2.0
  - @kontsedal/olas-persist@0.2.0

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
  - @kontsedal/olas-persist@0.1.0

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
  - @kontsedal/olas-persist@0.0.6

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
  - @kontsedal/olas-persist@0.0.5
