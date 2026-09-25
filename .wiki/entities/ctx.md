---
name: ctx
description: The tree-and-lifetime handle passed to every controller factory; the primitives that build lifetime-owned things take it as an argument instead.
type: entity
covers:
  - packages/core/src/controller/types.ts:191-308
  - packages/core/src/controller/instance.ts:455-1077
  - packages/core/src/query/bind.ts
  - packages/core/src/forms/bind.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: uses, target: controller-instance.md }
  - { type: related, target: ../modules/controller.md }
  - { type: documented-in, target: ../decisions/ctx-primitives-are-free-functions.md }
last_verified: 2026-09-25
confidence: medium
---

# `Ctx`

The single argument to every controller factory: `(ctx, props) => api`. Everything created through it, or with it, is owned by the controller and disposed when the controller disposes. Spec §3.2.

**`ctx` carries the tree and the lifetime.** Children, effects, scopes, emitters and the lifecycle hooks are methods on it. The primitives that build lifetime-owned *things* are standalone functions taking `ctx` first:

- `createField`, `createForm` and `createFieldArray` in `forms/bind.ts`;
- `createQuery`, `createCache`, `createMutation` and `bindQuery` in `query/bind.ts`;
- in the satellites, `createPersisted`, `createZodForm`, `createRealtimePatcher`, `createLiveStream` and `createConnectionState`.

`createField(ctx, '')` and `createQuery(ctx, userQuery, key)` are the shape. They reach the controller through a symbol-keyed internals handle, `ctxInternals(ctx, name)` (`controller/internals.ts`). `signal` and `computed` are plain imports from core, and nothing about them is controller-owned.

That split is what lets a bundler drop the forms subsystem and the query engine from a controller that never uses them. When the split landed, a controllers-only bundle measured 4.8 KB gzipped rather than 20.1 KB. See [`../decisions/ctx-primitives-are-free-functions.md`](../decisions/ctx-primitives-are-free-functions.md).

## Surface

```ts nocheck
type Ctx<TDeps = AmbientDeps> = {
  // composition
  child, attach, collection, lazyChild, effect, emitter, on

  // devtools (dev-only)
  debug

  // scopes
  provide, inject

  // lifecycle
  onDispose, onSuspend, onResume

  // DI
  readonly deps: TDeps

  // internal: the handle the ctx-taking functions use
  readonly [CTX_INTERNALS]: CtxInternals
}
```

The type is `controller/types.ts:198-308`. `Ctx` has no `ctx.session`, no `ctx.signal` or `ctx.computed`, and none of the primitive factories above as members; each of those left `Ctx` in 1.0.

The implementation is `buildCtx()` on `ControllerInstance` (`instance.ts:455-1077`). Each method has the same general shape:

1. Create the primitive.
2. Push a `LifecycleEntry` onto `self.entries`.
3. Return the primitive.

The ctx-taking functions follow the same shape through the internals handle: `internals.assertLive(name)`, then `internals.register(entry)` (`instance.ts:473-501`, `query/bind.ts:68-89`).

`ctx.effect`, `ctx.on`, and the lifecycle hooks also wrap user callbacks in a `dispatchError(rootShared.onError, err, {kind, controllerPath})` shield.

**`ctx.debug({...})` is the exception to that shape.** It pushes no `LifecycleEntry` and returns nothing. It merges the given live values onto `instance.debugValues` for the devtools "Variables" view. During construction those ride out on `controller:constructed`'s `debug` field, and afterwards on a `controller:debug` event. A call while the controller is suspended sends its event on `resume()`. It is `__DEV__`-only, a no-op in production that retains nothing there, and it does NOT `assertLive`, so it is safe to call from an effect after construction. See `../modules/devtools.md`.

## When is `ctx.*` callable?

Spec §3.4: **any time during the controller's active lifetime, not only the initial factory run**. Dynamically-created primitives integrate into the same `entries` list and dispose with the controller. This lets you e.g. spin up a field inside an effect that responds to schema changes — see the dynamicFormController example in spec §3.4.

Individual primitives also expose `.dispose()` — idempotent, safe to call early. The owning controller will call it again on its own dispose; both calls are no-ops after the first.

**After dispose, every `ctx.*` factory and every ctx-taking function throws** `[olas] <name>() called after the controller was disposed`, where `<name>` is `effect`, `createQuery` and so on. The guard is `assertLive` in `buildCtx` (`instance.ts:463-467`), which the ctx-taking functions call through the internals handle. A captured `ctx` reused past its owner's lifetime is a programming error. Without the guard the factory would push into a cleared lifecycle list and leak a live child, subscription and effect. `ctx.effect` used to silently no-op — now it throws like the rest (T2.4). Reads (`ctx.deps`, `ctx.inject`) don't throw. Pinned by `regressions.test.ts` R-L2.4.

## `ctx.deps` — DI surface

Read-only getter on `ctx`. Returns the merged deps object (parent's deps + any overrides from `ctx.child(def, props, { deps })`). The override case spreads into a fresh object; without override, the parent's deps reference is reused (preserves identity equality for tests).

## `createQuery` overload dispatch

`createQuery(ctx, query, keyOrOptions?)` is implemented as a single function that switches on the query's brand (`query/bind.ts:68-89`). It reads `query[BRAND]`, calls `createInfiniteUse` for `'infiniteQuery'` and `createUse` otherwise, and registers the resulting handle as a `subscription-cache` lifecycle entry. The TS overloads in `query/bind.ts:26-67` declare three signatures: a `Query` with `select` options, a `Query`, and an `InfiniteQuery`. Consumers see the right return shape.

## `ctx.attach` vs `ctx.child`

`ctx.child(def, props)` returns only `api` — the child's lifecycle is fully owned by the parent (dispose cascades, no manual control). `ctx.attach(def, props)` returns `{ api, dispose, suspend, resume }`: the child is still parent-owned (dispose cascades automatically), but the caller gets explicit handles to tear it down early or freeze/thaw it. `<SuspendOnUnmount controller={...}>` in `@kontsedal/olas-react` consumes `{ suspend, resume }` directly. See `controller-instance.md` for cascade semantics.

## Dynamic-child surface

`ctx.attach(...)`, `ctx.collection(...)` and `ctx.lazyChild(...)` cover the three dynamic-child cases. A child with its own early-dispose handle, such as a modal form or a tenant switch. A keyed homogeneous list, such as board cards. A code-split-loaded child, such as a modal. Construction failures route through `onError({ kind: 'construction' })`. See [`modules/controller.md`](../modules/controller.md) and `packages/core/tests/dynamic-children.test.ts`.

`provide` and `inject` cover cross-tree dependency injection — see [`scope.md`](scope.md) for the semantics and [`modules/react.md`](../modules/react.md) for the React adapter that composes with them.
