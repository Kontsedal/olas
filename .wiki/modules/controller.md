---
name: controller
description: defineController, createRoot and its root handle, ControllerInstance, Ctx and the ctx-internals seam — the heart of the library.
type: module
covers:
  - packages/core/src/controller/types.ts
  - packages/core/src/controller/define.ts
  - packages/core/src/controller/instance.ts
  - packages/core/src/controller/internals.ts
  - packages/core/src/controller/root.ts
  - packages/core/src/controller/index.ts
  - packages/core/src/testing.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/dynamic-children.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: uses, target: ../flows/construction-rollback.md }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: related, target: ../decisions/root-handle-separate.md }
  - { type: related, target: ../decisions/ctx-primitives-are-free-functions.md }
last_verified: 2026-09-25
confidence: high
---

# `packages/core/src/controller/`

## Purpose

Implements the controller container: `defineController`, `createRoot` and the root handle, the `Ctx` surface, and the lifecycle (construct → active → optionally suspended → disposed). Spec §3, §4, §12.1, §20.8.

## Files

- **`types.ts`** — `Ctx<TDeps>`, `Root<Api>` (the handle), `RootOptions`, `SuspendOptions`, `ControllerDef`, `AmbientDeps`, `Field`, `Collection` and its option types, `LazyChild`.
- **`define.ts`** — `defineController(factory, { name? })`, with one signature and `Props = void` as the default, which dodges the TS overload pitfalls (see `../pitfalls/literal-type-narrowing.md`). `getFactory` and `getName` read the internal `__factory` and `__name` off a `ControllerDef` (`packages/core/src/controller/define.ts:29-51`).
- **`instance.ts`** — the `ControllerInstance` class. It owns the lifecycle list and builds each `Ctx`, and most of the lifecycle implementation lives here. See `../entities/controller-instance.md`.
- **`internals.ts`** — `CTX_INTERNALS`, a `Symbol.for` key, and `CtxInternals`, the seam the free-function primitives use (`internals.ts:20-57`). `ctxInternals(ctx, op)` reads it and throws a message naming the fix when handed something that is not a ctx (`internals.ts:65-74`). The reasoning is in `../decisions/ctx-primitives-are-free-functions.md`.
- **`root.ts`** — `createRoot` and `createRootWithProps`, plus `buildRootHandle`, which returns the frozen root handle (`root.ts:100-208`).
- **`index.ts`** — public re-exports.

`testing.ts`, at the root of `core/src/`, is published as `@kontsedal/olas-core/testing`:

- `createTestController(def, { deps, props?, onError?, queries?, plugins?, scopes?, hydrate? })` returns the same `Root<Api>` as `createRoot`, so the api is on `.api` (`packages/core/src/testing.ts:27-65`). `props` is optional for a `void` controller. `queries` defaults to a live `queryEngine()`, and `null` builds a root with no engine.
- Each call builds its **own** root and so its own query cache, and two calls never share an entry. Test cache-lifetime behavior such as `gcTime` and dedup inside one root, through `ctx.attach`.
- `fakeField` and `fakeAsyncState` build shape-correct stand-ins for UI tests (`testing.ts:73-190`).
- It re-exports the plugin test helpers from `test-plugins.ts`: `mockFetchPlugin`, a `wrapFetch` that answers by query id, and `createPluginRecorder`, which records every observation event. `PLUGINS.md` shows them in use.
- `_unregisterMutationById` clears a `defineMutation` registration between test cases (`testing.ts:10`).

## Ctx surface

`Ctx` holds composition, effects, scopes and lifecycle (`types.ts:190-300`). The primitives that create data are free functions that take `ctx`: `createQuery`, `createCache`, `createMutation`, `bindQuery`, `createField`, `createForm`, `createFieldArray`, plus `signal` and `computed` from core.

```ts nocheck
type Ctx<TDeps = AmbientDeps> = {
  readonly [CTX_INTERNALS]: CtxInternals            // @internal, for the free-function primitives

  // composition
  child<Props, Api>(def, props, options?): Api
  attach<Props, Api>(def, props, options?):
    { api: Api; dispose(): void; suspend(): void; resume(): void }
  collection<Item, K, Props, Api>(opts): Collection<K, Api>      // homogeneous
  collection<Item, K, R>(opts): Collection<K, CollectionFactoryApi<R>>  // factory form
  lazyChild<Props, Api>(loader, props, options?): LazyChild<Api>

  // effects and events
  effect(fn: () => void | (() => void)): void
  emitter<T = void>(): Emitter<T>
  on<T>(emitter, handler): void
  debug(values: Record<string, unknown>): void      // devtools "Variables", dev-only

  // scopes (§10.3)
  provide<T>(scope, value): void
  inject<T>(scope): T

  // lifecycle
  onDispose(fn): void
  onSuspend(fn): void
  onResume(fn): void

  // DI
  readonly deps: TDeps
}
```

1.0 removed `ctx.cache`, `ctx.use`, `ctx.mutation`, `ctx.bindQuery`, `ctx.field`, `ctx.form`, `ctx.fieldArray`, `ctx.signal`, `ctx.computed` and `ctx.session`. `ctx.attach` covers what `ctx.session` did. A free function reaches the controller through `ctxInternals(ctx, op)`, calls `assertLive`, and registers its teardown with `register` (for example `packages/core/src/query/bind.ts:51-67`).

`ctx.attach(def, props)` returns `{ api, dispose, suspend, resume }`. `<SuspendOnUnmount controller={…}>` in `@kontsedal/olas-react` consumes the `{ suspend, resume }` pair directly, so the child needs no hand-rolled `isPaused` signal. `suspend` and `resume` cascade through the attached sub-tree's lifecycle entries: paused effects re-instantiate on resume, and suspended query subscriptions release their entry.

### Dynamic children: `attach`, `collection`, `lazyChild` (SPEC §11.1, §16.5)

- **`ctx.attach(def, props)`** — a child with its own handle, `{ api, dispose, suspend, resume }`. It lives until `dispose()` or parent disposal, whichever comes first. For modals, inline edit sessions and wizards.
- **`ctx.collection(options)`** — a keyed set of child controllers driven by a reactive `source` signal. New keys construct, removed keys dispose, and unchanged keys are left alone, with `propsOf` **not** re-applied. There are two forms. `controller` plus `propsOf` covers homogeneous items. `factory: (item) => { controller, props }` covers heterogeneous and type-discriminated items, and a key whose factory result picks a different controller is rebuilt. The diff loop registers as an `effect` lifecycle entry, so it pauses on `suspend()` and re-runs on `resume()` against the current source. A construction throw routes to `onError` with `kind: 'construction'`, and the collection skips that item, so `items.value` shows one fewer entry. The reconcile body reads only `source.value` in the tracked scope. `keyOf`, the item factory, and child construct and dispose run inside `untracked(...)` (`instance.ts:755-825`). A child factory that reads an unrelated signal therefore cannot re-run the whole reconcile on every write to it (T2.3).
- **`ctx.lazyChild(loader, props)`** — a code-split child. `status` walks `'idle' → 'loading' → ('ready' | 'error')`, next to `api: ReadSignal<Api | undefined>` and `error: ReadSignal<unknown>`. `load()` returns the same promise on repeat calls, and a rejected load clears it so the next call retries. A loader or construction throw sets `'error'` and routes to `onError` with `kind: 'construction'`. When the parent disposes during a load, the settle is dropped and the construction skipped. Parent dispose cascades into a loaded child through its `child` entry.

Tests in `packages/core/tests/dynamic-children.test.ts` cover all three. `root.replaceController` is a `BACKLOG.md` idea.

## Lifecycle architecture

A `ControllerInstance` owns a `LifecycleList`, a doubly-linked list of `LifecycleEntry` nodes that unlinks in O(1) (`instance.ts:103-147`). Every primitive registers one entry:

| Entry kind | Created by | Dispose | Suspend | Resume |
|------------|-----------|---------|---------|--------|
| `effect` | `ctx.effect(fn)`; `ctx.collection`'s reconcile loop | call dispose | call dispose, keep the factory | re-instantiate from the factory |
| `cleanup` | `ctx.emitter`, `createCache`, `createField`, `createForm`, `createFieldArray`, `createMutation` | call dispose | — | — |
| `subscription-cache` | `createQuery` | call dispose | release the entry, pause timers | re-acquire, refetch when stale |
| `child` | `ctx.child`, `attach`, `collection`, `lazyChild` | recurse `dispose()` | recurse `suspend()` | recurse `resume()`, unless explicitly suspended |
| `subscription` | `ctx.on(emitter, handler)` | call unsubscribe | — | — |
| `onDispose` | `ctx.onDispose(fn)`; `lazyChild`'s dispose flag | call fn | — | — |
| `onSuspend` | `ctx.onSuspend(fn)` | — | call fn | — |
| `onResume` | `ctx.onResume(fn)` | — | — | call fn |

Dispose and suspend iterate in **reverse** order, and resume iterates **forward**. See `../flows/construction-rollback.md` and `../pitfalls/dispose-order-is-registration-order.md`.

## The root handle

`createRoot(def, options)` returns a frozen `Root<Api>` (`types.ts:360-408`, `root.ts:176-207`):

```ts nocheck
type Root<Api> = {
  readonly api: Api                          // what the root factory returned
  bindQuery(query, options?): QueryActions | InfiniteQueryActions
  inject<T>(scope: Scope<T>): T
  dispose(): void
  suspend(options?: SuspendOptions): void
  resume(): void
  dehydrate(): DehydratedState
  hydrate(state: DehydratedState): void
  waitForIdle(): Promise<void>
  readonly debug: DebugBus                   // { subscribe, queryEntries }
}
```

The api and the controls never share an object, so a controller may return members named `dispose` or `suspend`, and a primitive api is returned as it is on `root.api`. The reasoning is in `../decisions/root-handle-separate.md`. Pinned by `controller.test.ts`: "an api may use the names of root controls; the two never collide", "a primitive api is returned as-is on root.api" and "the root handle is frozen".

Without a query engine:
- `root.bindQuery` throws the `missingQueryEngine` message;
- `root.dehydrate()` returns `{ version: 1, entries: [] }`;
- `root.hydrate(state)` discards the payload with a development warning (`root.ts:161-174`).

With an engine, `hydrate` goes to `QueryClient.hydrateLive`. `root.inject(scope)` resolves through `ControllerInstance.resolveScope`, the same walk `ctx.inject` uses.

`createRootWithProps` (`root.ts:19-98`) creates the client, sets up the plugins in order, seeds plugin scopes and then `RootOptions.scopes`, and runs the factory. A factory or setup throw tears down what was built and rethrows. `root.dispose()` closes plugin delivery, closes the client, disposes the controllers, disposes the plugins in reverse, then disposes the client (`root.ts:111-127`). `root.waitForIdle()` alternates between the client's idle wait and the plugins' tracked work (`root.ts:191-201`). The full sequence is `../flows/plugin-lifecycle.md`.

`suspend({ maxIdleTime })` arms an auto-dispose that many milliseconds out, and `resume()` or `dispose()` cancels it (`root.ts:129-154`). It schedules through `scheduleExpiry` in `packages/core/src/expiry-timer.ts` rather than a bare `setTimeout`. `maxIdleTime: Infinity` arms nothing, so the root stays suspended until something else disposes it. A finite value above the 32-bit timer limit is chunked rather than overflowing into an immediate dispose. `suspendTimer` holds the cancellation closure. See `../pitfalls/isstale-needs-timer.md`, and the `maxIdleTime` tests in `controller.test.ts`.

## What lives in `RootShared`

The instance constructor receives `RootShared = { devtools, onError, queryClient, queryDefaults, scopesVersion }` (`instance.ts:23-46`), and every descendant shares the same reference:
- `queryClient` is `null` without an engine, and `CtxInternals.requireClient` throws the message naming the fix.
- `queryDefaults` holds `queryEngine({ defaults })` so `createCache` can read two fields without pulling in the engine.
- `scopesVersion` is the counter every `ctx.provide` bumps to invalidate cached `inject` lookups.
