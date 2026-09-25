---
name: glossary
description: Domain vocabulary used across the codebase and spec.
type: glossary
covers:
  - SPEC.md
  - packages/core/src/index.ts
edges:
  - { type: related, target: overview.md }
last_verified: 2026-09-25
confidence: medium
---

# Glossary

Terms used across the spec, code, and wiki. Alphabetical.

**Ambient deps.** The `AmbientDeps` interface (in `controller/types.ts`). Users module-augment it to add app-wide services; every `ctx.deps` carries that type. Default has an index signature so `ctx.deps.anything` compiles as `unknown`.

**AsyncState.** What every cache subscription exposes: the ten signals `data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt`, `hasPendingMutations`, `isPaused` and `isEnabled`, plus the methods `refetch`, `reset`, `cancel` and `firstValue`. Defined in `query/types.ts:34-69`.

**Brand.** A value's kind, stored under core's non-exported `BRAND` symbol (`packages/core/src/brand.ts`). A `ControllerDef` carries `'controller'`, a `Query` `'query'`, an `InfiniteQuery` `'infiniteQuery'`, a `QueryEngine` `'queryEngine'`, a `Scope` `'scope'`, and a `defineMutation` result `'mutation'`, non-enumerable. `createQuery` dispatches on it. See `decisions/brand-markers-not-classes.md`.

**callArgs and keyArgs.** Inside `ClientEntry`, `callArgs` is the original args from the consumer, forwarded to the fetcher. `keyArgs` is the output of `spec.key(...callArgs)`, used for hashing. They are not interchangeable. See `pitfalls/callargs-vs-keyargs.md`.

**Canonical and optimistic writes.** `query.write` and `query.replace` are canonical: they push no snapshot and leave `hasPendingMutations` alone. `query.setData` is optimistic: it returns a `Snapshot` a mutation settles. See `decisions/canonical-vs-optimistic-writes.md`.

**ClientEntry and InfiniteClientEntry.** Per-root wrapper around `Entry` and `InfiniteEntry`. Adds subscriber-count, gcTime timer, and refetchInterval timer. Lives in `QueryClient`'s maps.

**Controller.** A factory function `(ctx, props) => api` produced by `defineController(...)`. Returns whatever the factory returns. The runtime instance is `ControllerInstance`.

**ControllerDef.** The value returned by `defineController`. Branded `'controller'`. Carries an internal `__factory` reference.

**Ctx.** The lifecycle-bound handle passed to every controller's factory function. Its methods are `child`, `attach`, `collection`, `lazyChild`, `effect`, `emitter`, `on`, `debug`, `provide`, `inject`, `onDispose`, `onSuspend` and `onResume`, plus `deps`. The primitives that build owned things take `ctx` as their first argument instead: `createField`, `createForm`, `createFieldArray`, `createQuery`, `createCache`, `createMutation` and `bindQuery`. See `entities/ctx.md`.

**Entry.** The state machine for one cache slot, race-protected via a `currentFetchId` and carrying the snapshot stack for optimistic updates. Local `createCache` uses it directly, and shared queries reach it through `ClientEntry`. `InfiniteEntry` is the paginated variant.

**Field.** A primitive form input — `ReadSignal<T>` plus errors, isValid, isDirty, touched, isValidating, plus methods (`set`, `setAsInitial`, `reset`, `markTouched`, `revalidate`, `setErrors`). Field IS a ReadSignal, so `field.value` returns `T` directly.

**Form and FieldArray.** Aggregates. `Form` has a static schema of named children; `FieldArray` has dynamic-length children built from a factory. Each is a `ReadSignal` of its aggregate value, like `Field`, so `form.value` is the value. See `decisions/forms-are-read-signals.md`.

**id.** The hand-written, stable name every `defineQuery`, `defineInfiniteQuery` and `defineMutation` requires. SSR payloads, plugin events, devtools and error contexts all name the query or mutation by it. See `decisions/required-id-and-meta.md`.

**isFetching and isLoading.** isFetching = any fetch in flight (including background refetch). isLoading = first load, no data yet. Spinners use isLoading; progress bars use isFetching.

**LocalCache.** Anonymous cache owned by one controller (`createCache(ctx, fetcher, options)`). Not shared. Disposed with the controller.

**meta.** Per-query and per-mutation plugin settings: `QueryMeta` and `MutationMeta` are empty interfaces that plugin packages augment, for example `meta: { crossTab: true }` or `meta: { persist: true }`. Core never reads them.

**Mutation.** A controller-scoped async write. It carries a concurrency policy of parallel, latest-wins or serial, optimistic updates, and the lifecycle callbacks `onMutate`, `onSuccess`, `onError` and `onSettled`.

**origin.** Who asked for a cache write or invalidate, carried on every plugin event. It is the plugin's name for a write through its host, or the `origin` given to `bindQuery(ctx, query, { origin })`. It is `undefined` for the app and the engine's own fetches. Cross-tab mirrors only origin-`undefined` writes by default.

**Plugin.** An `OlasPlugin`, `{ name, setup(host) }`, made with `definePlugin`. `createRoot` calls `setup` once per root, before the root factory, and `setup` returns the hooks. The host is a `PluginHost`. See `decisions/plugin-host-v2.md` and `flows/plugin-lifecycle.md`.

**Query.** Module-scoped, keyed, sharable cache definition produced by `defineQuery`. Branded `'query'`. Per-root binding happens via `QueryClient.bindEntry`.

**Query engine.** The value `queryEngine({ defaults })` returns. A root gets a `QueryClient` only when `createRoot` receives one as `queries`, so a root without it leaves the cache engine out of the bundle.

**QueryClient.** Per-root entry registry. Owns the maps of `ClientEntry` and `InfiniteClientEntry`, the `byId` index plugins address queries through, and a `mutationsInflight$` signal used by `waitForIdle`.

**Read/Signal/Computed.** `Signal<T>` extends `ReadSignal<T>`. Computed is a read-only signal whose value is derived. Implemented as thin wrappers over `@preact/signals-core`.

**Root.** The handle `createRoot` returns. `api` is what the root controller's factory returned. The rest is the root's own surface: `dispose`, `suspend`, `resume`, `dehydrate`, `hydrate`, `waitForIdle`, `bindQuery`, `inject` and `debug`. See `decisions/root-handle-separate.md`.

**RootShared.** The shared context for a tree: `devtools`, `onError`, `queryClient` (`null` without a query engine), `queryDefaults` and `scopesVersion`. Passed to every `ControllerInstance` constructor and propagated to descendants.

**Snapshot.** An object `{ rollback, finalize }` returned by `setData` (and produced by `onMutate`). The Entry stores the pre-update value; rollback restores it, and finalize commits the update. Multiple live snapshots stack (§6.4).

**Stale time and GC time.** `staleTime` — how long data is considered fresh; influences refetch-on-subscribe. `gcTime` — after the last subscriber leaves, how long the entry sticks around before being dropped.

**Suspend and Resume vs Dispose.** Suspend stops effects, recurses into children, and releases each query subscription's entry, which `gcTime` then governs (`query/use.ts:323-333`). The controllers and their state survive. Resume re-instantiates effects and rebinds the subscriptions, and a stale entry refetches. Dispose tears down. Use suspend for "definitely coming back soon", such as tab UIs. Use dispose for "user navigated away", where gcTime carries cached data forward.

**Validators.** Functions `(value, signal) => ValidatorResult | Promise<ValidatorResult>`, where `ValidatorResult` is `string | null | FormIssue[]` (`forms/types.ts:22-33`). Run in a tracking scope so reading signals inside re-runs the validator when those signals change. Sync validators run first, and the async ones are not called when a sync one fails (spec §8.1).

**WriteEvent.** What a plugin's `onWrite` receives: the query ref, key, data, `updatedAt`, `origin`, and a `source` of `'fetch'`, `'hydrate'`, `'optimistic'`, `'rollback'`, `'write'` or `'replace'`. The devtools `cache:set-data` event uses the same sources.
