---
name: controller
description: defineController, createRoot, ControllerInstance, Ctx — the heart of the library.
type: module
covers:
  - packages/core/src/controller/types.ts
  - packages/core/src/controller/define.ts
  - packages/core/src/controller/instance.ts
  - packages/core/src/controller/root.ts
  - packages/core/src/controller/index.ts
  - packages/core/src/testing.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/dynamic-children.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: uses, target: ../flows/construction-rollback.md }
last_verified: 2026-05-22
confidence: high
---

# `packages/core/src/controller/`

## Purpose

Implements the controller container: `defineController`, `createRoot`, the `Ctx` surface, and the lifecycle (construct → active → optionally suspended → disposed). Spec §3, §4, §12.1.

## Files

- **`types.ts`** — `Ctx<TDeps>`, `Root<Api>`, `ControllerDef`, `RootOptions`, `AmbientDeps`, `Field` interface.
- **`define.ts`** — `defineController` (one signature with `Props = void` default; this dodges TS overload pitfalls — see `pitfalls/literal-type-narrowing.md` context). `getFactory` extracts the internal `__factory` from a `ControllerDef`.
- **`instance.ts`** — `ControllerInstance` class. Owns the `entries: LifecycleEntry[]` list and the `Ctx` factory. ~600 lines; the lifecycle implementation lives here.
- **`root.ts`** — `createRoot` / `createRootWithProps`. Wraps the root `ControllerInstance` with `dispose / suspend / resume / dehydrate / waitForIdle / __debug` non-enumerable methods on the returned api (see `attachRootControls` in `root.ts:71-157`).
- **`index.ts`** — public re-exports.

`testing.ts` (root of `core/src/`) lives at `@kontsedal/olas-core/testing` — exports `createTestController(def, { deps, props })`, equivalent to `createRootWithProps` but more ergonomic for tests.

## Ctx surface (Phase 0–12)

```ts
type Ctx<TDeps = AmbientDeps> = {
  // async data
  cache<T>(fetcher, options?): LocalCache<T>
  use<Args, T>(query, keyOrOptions?): QuerySubscription<T>     // dispatches on __olas brand
  use<Args, TPage, TItem>(infinite, keyOrOptions?): InfiniteQuerySubscription<TPage, TItem>
  mutation<V, R>(spec): Mutation<V, R>

  // forms
  field<T>(initial, validators?): Field<T>
  form<S>(schema, options?): Form<S>
  fieldArray<I>(itemFactory, options?): FieldArray<I>

  // composition
  child<Props, Api>(def, props, options?): Api
  attach<Props, Api>(def, props, options?):
    { api: Api; dispose: () => void; suspend: () => void; resume: () => void }
  session<Props, Api>(def, props, options?): readonly [Api, () => void]
  collection<Item, K, Props, Api>(opts): Collection<K, Api>      // homogeneous
  collection<Item, K, R>(opts): Collection<K, ApiOf<R>>          // factory form
  lazyChild<Props, Api>(loader, props, options?): LazyChild<Api>
  effect(fn): void
  emitter<T>(): Emitter<T>
  on<T>(emitter, handler): void

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

`ctx.attach(def, props)` returns `{ api, dispose, suspend, resume }`. `<KeepAlive controller={...}>` in `@kontsedal/olas-react` consumes the `{ suspend, resume }` pair directly — no hand-rolled `isPaused` signal on the child. `suspend` / `resume` cascade through the attached sub-tree's `LifecycleEntry[]`, paused effects re-instantiate on resume, suspended cache subscriptions release their entry.

### Dynamic children: `session` / `collection` / `lazyChild` (SPEC §11.1, §16.5)

- **`ctx.session(def, props)`** — ephemeral child returning `[api, dispose]`. Same wiring as `ctx.attach` minus the suspend / resume handle: lifetime is `dispose()` OR parent disposal, whichever comes first. For modals, inline edit sessions, wizards.
- **`ctx.collection(options)`** — keyed set of child controllers driven by a reactive `source` signal. New keys construct, removed keys dispose, unchanged keys are left alone (`propsOf` is **not** re-applied). Two forms: `controller` + `propsOf` for homogeneous items, or `factory: (item) => { controller, props }` for heterogeneous / type-discriminated items (a key whose factory result picks a different controller is rebuilt). The diff loop registers as an `effect` lifecycle entry, so it pauses on `suspend()` and re-runs on `resume()`, reconciling against the current source. Construction throws route to `onError` with `kind: 'construction'` and the bad item is skipped — `items.value` shows one fewer entry. Child controllers are added/removed from the parent's `entries[]` so they participate in suspend / resume / dispose cascade.
- **`ctx.lazyChild(loader, props)`** — code-split child. `status: 'idle' → 'loading' → ('ready' | 'error')`, plus `api: ReadSignal<Api | undefined>` and `error: ReadSignal<unknown | undefined>`. `load()` is idempotent (returns the same promise on repeat calls). Loader or controller-construction throws flip status to `'error'` and route through `onError(kind: 'construction')`. If the parent disposes while a load is in flight, the eventual settle is dropped on the floor (the construction is skipped). Parent dispose cascades into the loaded child via the normal `kind: 'child'` entry.

Tests in `packages/core/tests/dynamic-children.test.ts` exercise all three.

What's **not yet** on Ctx: `replaceController`, `dynamicCollection`. Those remain in `BACKLOG.md`.

## Lifecycle architecture

A `ControllerInstance` owns a flat `LifecycleEntry[]`. Every primitive registers one entry:

| Entry kind | Created by | Dispose action | Suspend action | Resume action |
|------------|-----------|----------------|----------------|---------------|
| `effect` | `ctx.effect(fn)` | call dispose | call dispose, store factory | re-instantiate via factory |
| `cleanup` | `ctx.cache`, `ctx.emitter`, `ctx.field`, `ctx.form`, `ctx.fieldArray`, `ctx.mutation` | call dispose | — | — |
| `child` | `ctx.child(...)` | recurse `child.dispose()` | recurse `child.suspend()` | recurse `child.resume()` |
| `subscription` | `ctx.on(emitter, handler)` | call unsubscribe | — | — |
| `onDispose` | `ctx.onDispose(fn)` | call fn | — | — |
| `onSuspend` | `ctx.onSuspend(fn)` | — | call fn | — |
| `onResume` | `ctx.onResume(fn)` | — | — | call fn |

Dispose iterates **reverse** order, suspend iterates reverse, resume iterates **forward**. See `flows/construction-rollback.md`.

## Root controls

`attachRootControls(api, instance, devtools, queryClient)` in `root.ts:71-157` defines six non-enumerable properties on the api object: `dispose`, `suspend`, `resume`, `dehydrate`, `waitForIdle`, `__debug`. Conflicts with controller-supplied keys throw at construction.

`suspend({ maxIdle: ms })` — schedules a `setTimeout` to dispose if not resumed within `ms`. `resume()` cancels it.

## What lives in `RootShared`

The instance constructor receives `RootShared = { devtools, onError, queryClient }`. Every descendant shares the same reference. Mutations, queries, and devtools events all route through this object.
