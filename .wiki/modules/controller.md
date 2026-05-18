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
  - { type: uses, target: signals.md }
  - { type: uses, target: ../entities/ctx.md }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: uses, target: ../flows/construction-rollback.md }
last_verified: 2026-05-18
confidence: high
---

# `packages/core/src/controller/`

## Purpose

Implements the controller container: `defineController`, `createRoot`, the `Ctx` surface, and the lifecycle (construct → active → optionally suspended → disposed). Spec §3, §4, §12.1.

## Files

- **`types.ts`** — `Ctx<TDeps>`, `Root<Api>`, `ControllerDef`, `RootOptions`, `AmbientDeps`, `Field` interface.
- **`define.ts`** — `defineController` (one signature with `Props = void` default; this dodges TS overload pitfalls — see `pitfalls/literal-type-narrowing.md` context). `getFactory` extracts the internal `__factory` from a `ControllerDef`.
- **`instance.ts`** — `ControllerInstance` class. Owns the `entries: LifecycleEntry[]` list and the `Ctx` factory. ~370 lines; the lifecycle implementation lives here.
- **`root.ts`** — `createRoot` / `createRootWithProps`. Wraps the root `ControllerInstance` with `dispose / suspend / resume / dehydrate / waitForIdle / __debug` non-enumerable methods on the returned api.
- **`index.ts`** — public re-exports.

`testing.ts` (root of `core/src/`) lives at `@olas/core/testing` — exports `createTestController(def, { deps, props })`, equivalent to `createRootWithProps` but more ergonomic for tests.

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
  effect(fn): void
  emitter<T>(): Emitter<T>
  on<T>(emitter, handler): void

  // lifecycle
  onDispose(fn): void
  onSuspend(fn): void
  onResume(fn): void

  // DI
  readonly deps: TDeps
}
```

What's **not yet** on Ctx: `collection`, `session`, `lazyChild`, `provide`, `inject`, `dynamicCollection`. Those are in spec §20.2 but belong to phases 10+.

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

`attachRootControls(api, instance, devtools, queryClient)` in `root.ts:50-130` defines six non-enumerable properties on the api object: `dispose`, `suspend`, `resume`, `dehydrate`, `waitForIdle`, `__debug`. Conflicts with controller-supplied keys throw at construction.

`suspend({ maxIdle: ms })` — schedules a `setTimeout` to dispose if not resumed within `ms`. `resume()` cancels it.

## What lives in `RootShared`

The instance constructor receives `RootShared = { devtools, onError, queryClient }`. Every descendant shares the same reference. Mutations, queries, and devtools events all route through this object.
