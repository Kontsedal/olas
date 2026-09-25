# @kontsedal/olas-entities

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

- 360120c: **A development build behind a `development` export condition.** Devtools now work against the published packages.
  
  Until now, the release build inlined `__DEV__ = false`, so the core on npm emitted no devtools events at all. `@kontsedal/olas-devtools` showed an empty controller tree and timeline against it, and the dev-only warnings in core, entities, persist, react and zod never fired in an app.
  
  Each of these packages now ships two builds:
  - `dist/` is the default, a production build with every dev-only branch stripped;
  - `dist/dev/` sits behind the `development` condition, with the devtools events and the dev warnings kept.
  
  Vite's dev server, webpack and Rspack in development mode, and Next.js in dev resolve `development` without configuration, and their production builds resolve the default. With esbuild or Rollup, add `conditions: ['development']` to the dev config; in Node, `--conditions=development`. A browser with no bundler, or a CDN, gets the default build, as before.
  
  The production build is unchanged, and so are the bundle sizes. SPEC §23 has the details.
- 439b8c2: **Cross-tab and entities report on their devtools lanes.** `@kontsedal/olas-devtools` shows one lane per plugin, and these two sent nothing on theirs.
  
  - **cross-tab** reports each message it posts and each message a peer sent. An event names the direction, the message type, the query and key, the sender's `sourceId` and `msgId`, and what became of it. A send is `posted` or `not-cloneable`. A receive is `applied`, `duplicate`, `malformed`, `ignored`, `rejected` or `failed`. The sender's id and `msgId` name one message in both tabs' lanes.
  - **entities** reports each `update`: the entity and id, how many query entries the patch reached and their query ids, and how many listed entries no longer held the entity.
  
  The events are development-only. cross-tab now ships a development build behind the `development` export condition, like core and entities, and its default build strips the calls. That build grew by 10 B, from 1.31 kB to 1.32 kB brotlied.

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
- 439b8c2: **`entities.update` patches each query as it is now, and the walk is linear in shared data.**
  
  - **A patch lands where the entity is.** `update` used to write the patch at the paths the last walk recorded. Another plugin can change an entry before this plugin walks it. One earlier in the plugin list reacts to the write first, or one reacting to a backprop write rewrites another entry mid-update. A path that led nowhere dropped the patch silently. A path that something else had taken over got the patch instead. A reorder of `[p1, p2]` to `[p2, p1]` wrote p1's patch over p2. `update` now finds every node `idOf` claims with that id in the entry's current data and replaces it. An entry that no longer holds the entity gets no write, and its binding is dropped.
  - **The walk reads the entry as it is now.** On a write, the plugin walks the entry's current data instead of the event's. When an earlier plugin had already written the entry again, walking the older value put stale entities back into the store.
  - **A shared object is walked once.** The walker descended into a shared object once per path, so a chain of diamonds with 2^depth paths took 2^depth steps. It now descends into each object once, and the cost is linear in the objects and the references between them. A shared `Post` is still bound at every key that references it. An entity nested inside a shared object is bound at the path the walk first reached it by, so `bindings()` lists fewer paths there. The patch does not depend on the paths, rebuilds a shared object once, and keeps it shared.
  - **An updater that returns the stored value writes no query.**
- 6a561d9: A call on a disposed entity store now says the store was disposed.
  
  Disposing the root clears the same store that the registration check probes. Every call afterwards reported `entity "X" was not registered with entitiesPlugin({ entities })`, and sent the reader looking for a registration that was there all along. The disposed case now has its own message. An entity missing from `entitiesPlugin({ entities })` still gets the registration message.
- d0b11ef: **Member docs on object types now show in editor hover.** The declaration bundler moved every one-line member doc (`/** … */` on one line) onto the end of the previous member's line, where TypeScript attaches it to nothing. About 135 member docs were missing from the published `.d.ts` files, such as `ScopeOptions.name`, `PersistOptions.serialize` and most of the devtools and query option types. The sources now write member docs as multi-line blocks, which keep their own line, and the dist smoke check fails if a stranded doc comment comes back.
- 4aa2542: **entities: a handle from `signal(entity, id)` survives `remove` and `maxSlots` eviction.**
  
  `remove` and eviction used to delete the id's signal, so a view holding it stayed `undefined` after the entity came back, and a new `signal()` call returned a different object. The handle now reads whatever the store holds for the id: `undefined` while the entity is out, and the entity again once a query or `upsert` brings it back. It is the same object for as long as anything holds it. `maxSlots` no longer evicts an id a `subscribe` on its handle holds, so a mounted detail view keeps its entity after its query is collected. The handle is a read-only signal now, matching its `ReadSignal` type.
- 5d58d4d: **A subscription holds its slot after the caller drops the handle.**
  
  `const off = entities.signal(Item, 'p1').subscribe(fn)` keeps only the unsubscribe. Once the handle was garbage-collected, the store lost its subscription count, and `maxSlots` could evict p1 under the live subscriber, which then saw `undefined`. The store now holds a handle strongly while a `subscribe` on it is open, and lets it go when the last one closes.
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
- 4c47f81: **Brands are symbol keys, and `InfiniteQuery` gains `peek`, `write` and `replace`.**
  
  **Brands.** Public values no longer carry `__olas`, `__t`, `__types`, `__id`, `__options` or `__create`. A value's kind, its phantom type slot and the engine's plumbing now live under symbol keys that core does not export. They stay out of autocomplete, `Object.keys` and `JSON.stringify`. This affects `ControllerDef`, `Query`, `InfiniteQuery`, `QueryEngine`, `Scope`, the `defineMutation` result, and entities' `EntityDef`.
  
  The keys are `Symbol.for` symbols, so two copies of core in one bundle still recognize each other's values. Code that read `query.__olas` to tell a query from an infinite query should keep a reference to the definition instead.
  
  `Scope` loses `__id`. A scope object is its own identity.
  
  **`InfiniteQuery.peek`, `write` and `replace`** match `Query`'s:
  - `peek(...args)` reads the loaded pages without creating an entry or subscribing.
  - `write(...args, updater)` is a canonical patch. It pushes no snapshot and leaves an in-flight fetch alone.
  - `replace(...args, pages)` takes whole pages and cancels the in-flight fetch.
  
  The bound handles from `bindQuery` and `root.bindQuery` carry the same three methods.
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

- Updated dependencies
- Updated dependencies [6869769]
- Updated dependencies [7a07994]
  - @kontsedal/olas-core@0.0.2

## 0.0.1-rc.1

Initial release. Entity-normalization plugin.

- `defineEntity({ name, idOf })` — declare an entity type with an id extractor.
- `entitiesPlugin([Post, User, ...])` — installs as `QueryClientPlugin`. Observes
  every `SetDataEvent` (fetch / set / remote) and walks query data to populate an
  internal normalized store plus a reverse index of (entity-id → queries holding it).
- `entities.signal(Post, id)` — `ReadSignal<Post | undefined>` for per-entity
  subscriptions. Components consume via `use(...)` from `@kontsedal/olas-react`.
- `entities.upsert(Post, raw)` — explicit branding (for events / non-query sources).
- `entities.update(Post, id, patchOrUpdater)` — accepts `Partial<T>` (shallow merge)
  OR `(prev: T) => T` (updater function). Patches every query holding the id via
  `QueryClientPluginApi.setEntryData`. Batched into one notification round.
  Warns in dev when the entity isn't in the store.
- `entities.get(Post, id)` / `entities.invalidate(Post, id)` — non-reactive read /
  store removal.
- `entities.entries(Post)` / `entities.bindings(Post, id)` — devtools snapshots of
  the normalized store and the reverse index.

Notable behaviors:

- Walker uses stack-based cycle detection (`WeakSet` of currently-descending nodes),
  so shared-reference DAGs walk both paths but true cycles still terminate.
- Path accumulator is mutable across the walk; clones happen only at binding
  boundaries (push/pop on descent/ascent).
- `bindingKey` uses the core `stableHash` (now re-exported) so Date / undefined /
  key-ordering match the QueryClient's own entry hash.
- All public methods throw when called with an `EntityDef` that wasn't passed to
  `entitiesPlugin([...])`.
- Dev builds emit a one-shot warning when a single entity partition crosses 10k
  unique ids in the slot map.
