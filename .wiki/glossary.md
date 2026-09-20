---
name: glossary
description: Domain vocabulary used across the codebase and spec.
type: glossary
covers:
  - SPEC.md
last_verified: 2026-05-21
confidence: high
---

# Glossary

Terms used across the spec, code, and wiki. Alphabetical.

**Ambient deps.** The `AmbientDeps` interface (in `controller/types.ts`). Users module-augment it to add app-wide services; every `ctx.deps` carries that type. Default has an index signature so `ctx.deps.anything` compiles as `unknown`.

**AsyncState.** What every cache subscription exposes: the eight signals `data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `lastUpdatedAt` and `hasPendingMutations`, plus the methods `refetch`, `reset` and `firstValue`. Defined in `query/types.ts`.

**callArgs and keyArgs.** Inside `ClientEntry`, `callArgs` is the original args from the consumer, forwarded to the fetcher. `keyArgs` is the output of `spec.key(...callArgs)`, used for hashing. They are not interchangeable. See `pitfalls/callargs-vs-keyargs.md`.

**ClientEntry and InfiniteClientEntry.** Per-root wrapper around `Entry` and `InfiniteEntry`. Adds subscriber-count, gcTime timer, and refetchInterval timer. Lives in `QueryClient`'s maps.

**Controller.** A factory function `(ctx, props) => api` produced by `defineController(...)`. Returns whatever the factory returns. The runtime instance is `ControllerInstance`.

**ControllerDef.** The value returned by `defineController`. Branded `__olas: 'controller'`. Carries an internal `__factory` reference.

**Ctx.** The lifecycle-bound primitive factory passed to every controller's factory function. Surface includes `effect`, `emitter`, `field`, `form`, `fieldArray`, `cache`, `use`, `mutation`, `child`, `on`, `onDispose/Suspend/Resume`, `deps`. Each primitive registers cleanup with the owning controller.

**Entry.** The state machine for one cache slot, race-protected via a `currentFetchId` and carrying the snapshot stack for optimistic updates. Local `ctx.cache` uses it directly, and shared queries reach it through `ClientEntry`. `InfiniteEntry` is the paginated variant.

**Field.** A primitive form input — `ReadSignal<T>` plus errors, isValid, isDirty, touched, isValidating, plus methods (`set`, `reset`, `markTouched`, `revalidate`). Field IS a ReadSignal, so `field.value` returns `T` directly.

**Form and FieldArray.** Aggregates. `Form` has a static schema of named children; `FieldArray` has dynamic-length children built from a factory. Their `value` is a `ReadSignal<...>` (different from `Field`).

**isFetching and isLoading.** isFetching = any fetch in flight (including background refetch). isLoading = first load, no data yet. Spinners use isLoading; progress bars use isFetching.

**LocalCache.** Anonymous cache owned by one controller (`ctx.cache(fetcher, options)`). Not shared. Disposed with the controller.

**Mutation.** A controller-scoped async write. It carries a concurrency policy of parallel, latest-wins or serial, optimistic updates, and the lifecycle callbacks `onMutate`, `onSuccess`, `onError` and `onSettled`.

**Query.** Module-scoped, keyed, sharable cache definition produced by `defineQuery`. Branded `__olas: 'query'`. Per-root binding happens via `QueryClient.bindEntry`.

**QueryClient.** Per-root entry registry. Owns the maps of `ClientEntry` and `InfiniteClientEntry`, plus a `mutationsInflight$` signal used by `waitForIdle`.

**Read/Signal/Computed.** `Signal<T>` extends `ReadSignal<T>`. Computed is a read-only signal whose value is derived. Implemented as thin wrappers over `@preact/signals-core`.

**RootShared.** The shared context for a tree: `devtools`, `onError`, `queryClient`. Passed to every `ControllerInstance` constructor and propagated to descendants.

**Snapshot.** An object `{ rollback: () => void }` returned by `setData` (and produced by `onMutate`). The Entry stores the pre-update value; rollback restores it. Multiple live snapshots stack (§6.4).

**Stale time and GC time.** `staleTime` — how long data is considered fresh; influences refetch-on-subscribe. `gcTime` — after the last subscriber leaves, how long the entry sticks around before being dropped.

**Suspend and Resume vs Dispose.** Suspend pauses effects and recursion into children, while data and subscriptions survive. Resume re-instantiates effects. Dispose tears down. Use suspend for "definitely coming back soon", such as tab UIs. Use dispose for "user navigated away", where gcTime carries cached data forward.

**Validators.** Functions `(value, signal) => string | null | Promise<string | null>`. Run in a tracking scope so reading signals inside re-runs the validator when those signals change. Sync validators short-circuit; async only runs if sync passed.

**`__olas` brand.** Runtime discriminator used for dispatch in `ctx.use`. A `ControllerDef` carries `'controller'`, a `Query` carries `'query'`, and an `InfiniteQuery` carries `'infiniteQuery'`.
