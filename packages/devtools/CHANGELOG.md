# @kontsedal/olas-devtools

## 1.0.1

### Patch Changes

- e5f9834: **Under StrictMode, the panel's timeline shows the live controller tree once.**
  
  A root's debug bus replays its live controllers to each new subscriber. StrictMode attaches a panel's own store, detaches it and attaches it again, and the second replay went onto the timeline too: two controllers showed four `controller:constructed` rows. A store attached again now takes a replay that repeats its tree as a tree update with no timeline row. That is a `controller:constructed` for a controller it already has live, or a `controller:suspended` for one it already has suspended. A controller that changed while the store was detached still gets its row.

## 1.0.0

### Major Changes

- 008d8ef: **Devtools: mutation events carry `id`, and `inspectorPollMs` is gone.**
  
  - **core:** the `mutation:run`, `mutation:success`, `mutation:error` and `mutation:rollback` events carried the mutation's `id` in a field named `name`. 1.0 removed `name` from mutations, so the event field now matches the spec field: `event.id`. It is absent for an inline `createMutation` spec without an `id`.
  - **devtools:** `MutationEntry.name` is now `MutationEntry.mutationId`. `MutationEntry.id` already numbers the log entry, so the mutation's own id takes the longer name. The panel shows and searches the same text as before.
  - **devtools:** the deprecated `DevtoolsPanelProps.inspectorPollMs` is removed. The panel ignored it: the cache inspector refreshes on every cache event, so there is no interval to set. Delete the prop.
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

- 5930713: **`<DevtoolsLauncher>` records from mount and keeps its history when the window closes.**
  
  The panel built its store inside itself and unmounted when the window closed or minimized, so every close wiped the recorded events. Recording also started only when the window first opened. The launcher now builds one store, attaches it on mount and hands it to the panel. `<DevtoolsPanel>` takes that store through a new optional `store` prop. The panel renders a store it is given and leaves attaching it to the store's owner.
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

### Patch Changes

- 5930713: **The panel pairs a mutation's settle with its own run, and closes a cancelled run.**
  
  The store paired a settle with the oldest pending start of the same mutation. A superseded, reset or disposed run sends no settle, so its start stayed queued forever. Three `latest-wins` runs at 0, 100 and 200 ms whose last settled at 210 ms showed a 210 ms success, and each superseded run's timeline group stayed active.
  
  The store now pairs by the run id core sends as `causeId`, and reads core's new `mutation:cancel`. A cancelled run ends its timeline group with `cancel` and the reason. The Mutations log adds a `cancel` entry with the reason and the duration, and the Tree's pending badge drops. `MutationEntry` gains the `cancel` kind. The store ignores a cancel with no start on record, such as the one core sends for a queued `serial` run dropped before it started. It keeps at most 1,000 unfinished starts.
- 5930713: **A devtools error no longer unmounts the host app, and object key members render as JSON.**
  
  Two data shapes threw during render, and with no error boundary React unmounted the whole app. A null-prototype object in a query key, such as `query-string`'s `parse()` output, threw in `formatPath` and in the Cache filter. A `ctx.debug` computed that throws, such as `computed(() => items.value[0].name)` on an empty list, threw in the Tree. Its subscription also rethrew into the app's own write that made the computed throw.
  
  - `formatPath` renders an object member of a key as compact JSON, capped at 60 characters. `['users', { page: 1 }]` read `users › [object Object]` before. A cycle reads `[Circular]`.
  - `formatPayload` marks a cycle instead of falling back to `String()`, and returns `[unserializable]` when nothing can read the value.
  - A `ctx.debug` variable that throws shows `threw` and the error in its row, and updates when it stops throwing.
  - `<DevtoolsPanel>` shows a render error in place of the panel, with a Retry button. `<DevtoolsLauncher>` renders nothing when it fails outside the panel.
- 5930713: **`urlHashKey` leaves the app's own URL hash alone.**
  
  The panel parsed the whole hash as URL parameters, re-encoded it and wrote it back. `#/users/42?tab=posts` became `#%2Fusers%2F42%3Ftab=posts&olas=…`, and `#section` became `#section=&olas=…`. The write also cleared the router's `history.state`.
  
  The panel now keeps its state in one `key=value` segment. It writes only when the rest of the hash is empty or `key=value` pairs too, and those keep their exact bytes. It passes `history.state` through. It leaves a hash router's path or an anchor untouched, so there the panel state does not persist.
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
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- fcc805b: Rework the panel's visual layer so every value is picked by role from a named scale.
  
  - **Type and corners.** Nine literal font sizes, including `9.5px`, `10.5px`, `11.5px` and
    `12.5px`, become five role steps; eight corner radii become three tiers plus the pill.
  - **Palette.** Solved rather than sampled: every foreground clears 4.5:1 against all four
    surfaces and the new `--olas-border-control` clears the 3:1 WCAG 1.4.11 asks of an edge that
    identifies a control. The indigo accent becomes a sea teal.
  - **Chips.** A status chip painted its label in a status colour and its ground in a mix of that
    same colour, which moves the ground toward the label and spends the headroom the status tokens
    were solved to have. The chips drop the wash and take a solved edge.
  - **Casing.** The tree's state chips keep their small caps and lose the letter-spacing.
  - **Elevation.** The launcher and the floating window float, so each takes the shadow and drops
    its border. The launcher also loses a coloured glow and a decorative status dot that never
    changed and was `aria-hidden` beside a label already saying the same thing.
  - **Theming.** The tokens are now declared on `.olas-devtools`, `.olas-devtools-launcher` and
    `.olas-devtools-floating` together. The launcher and window sit outside the panel in the DOM, so
    they inherited none of its custom properties and carried hardcoded hex instead — which is why
    the launcher stayed dark in a light app. Both now honour a host's `--olas-*` overrides.
  - **Accessibility.** `JsonView` is an expand-and-collapse tree and had no `aria-` attributes at
    all; its toggles gain `aria-expanded` and the expanded ones, whose only content is a bracket,
    gain a name.
  - **Fonts.** The stack leads with the system UI stack instead of Inter.
  
  Removed tokens, none of which any rule still read: `--olas-accent-soft`, `--olas-success-soft`,
  `--olas-warn-soft`, `--olas-error-soft`. Added: `--olas-border-control`, `--olas-dim`,
  `--olas-accent-fg`, `--olas-font-ui`, `--olas-font-mono`, `--olas-shadow-float`, and the type,
  corner and motion scales.
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
- Updated dependencies [06b715f]
- Updated dependencies [fea5505]
- Updated dependencies [1648b9a]
- Updated dependencies [254b79b]
- Updated dependencies [008d8ef]
- Updated dependencies [da5829d]
- Updated dependencies [affe2b0]
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
- Updated dependencies [6a561d9]
- Updated dependencies [3f9b98d]
- Updated dependencies [20473ba]
- Updated dependencies [1299818]
- Updated dependencies [8791b0e]
- Updated dependencies [8791b0e]
- Updated dependencies [38cf416]
- Updated dependencies [4c47f81]
- Updated dependencies [38cf416]
- Updated dependencies [02b45f2]
  - @kontsedal/olas-core@1.0.0
  - @kontsedal/olas-react@1.0.0

## 0.8.0

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.0

### Minor Changes

- 939f932: `ctx.debug({...})` — controller variables in devtools.

  **Core** — new opt-in `ctx.debug(record)` primitive: registers named **live** values (signals / computeds / fields / plain values) for the devtools "Variables" view. Dev-only — a no-op in production (stripped like the rest of the `__debug` bus), so it costs nothing and retains nothing there. Construction-time registrations ride out on `controller:constructed` (new optional `debug` field); a call after construction emits the new `controller:debug` event. Both are replayed to late subscribers.

  **Devtools** — each controller node in the Tree now shows its `ctx.debug` variables, rendered **reactively** (a signal shows its current value and updates live as it changes — no polling; a plain value shows a snapshot). Lazy per expanded node.

### Patch Changes

- Updated dependencies [939f932]
- Updated dependencies [bba3e5c]
  - @kontsedal/olas-core@0.3.0
  - @kontsedal/olas-react@0.3.0

## 0.2.0

### Minor Changes

- eb859d9: Devtools causal timeline (overhaul T8.1 + T8.4).

  **Core** — `DebugEvent` gains optional `seq` / `t` / `causeId` correlation fields (stamped by the bus), plus new `cache:set-data` (carries `source` + the post-write `data`) and `snapshot:push` / `snapshot:rollback` / `snapshot:finalize` events. A mutation run's id and each fetch's id thread through the writes and snapshot events they trigger, so a whole optimistic-update chain shares one `causeId`. All dev-only — stripped from production builds. See SPEC §14.

  **Devtools** — new default **Timeline** tab: every event ordered by `seq` and grouped by `causeId` into collapsible cause-chains, each `cache:set-data` expandable to a structural before/after diff. The cache Inspector is now event-driven (the 800ms poll is gone). Also fixes a real-browser `Illegal invocation` crash of the rAF-coalesced flush (native `requestAnimationFrame` was assigned unbound), which had silently left the Cache / Mutations / Fields / Timeline views empty in every browser.

### Patch Changes

- Updated dependencies [eb859d9]
  - @kontsedal/olas-core@0.2.0
  - @kontsedal/olas-react@0.2.0

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
  - @kontsedal/olas-react@0.1.0

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
  - @kontsedal/olas-react@0.0.6

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
  - @kontsedal/olas-react@0.0.5

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
  - @kontsedal/olas-react@0.0.4

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
  - @kontsedal/olas-react@0.0.3

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
  - @kontsedal/olas-react@0.0.2

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
  - @kontsedal/olas-react@0.0.1-rc.1

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
  - @olas/react@0.0.1-rc.0
