---
name: ctx
description: The lifecycle-bound primitive factory passed to every controller factory.
type: entity
covers:
  - packages/core/src/controller/types.ts:90-166
  - packages/core/src/controller/instance.ts:257-587
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: uses, target: controller-instance.md }
  - { type: related, target: ../modules/controller.md }
last_verified: 2026-05-21
confidence: high
---

# `Ctx`

The single argument to every controller factory: `(ctx, props) => api`. Every primitive constructed through `ctx` is owned by the controller and disposed when the controller disposes. Spec §3.2.

## Surface (Phases 0–12)

```ts
type Ctx<TDeps = AmbientDeps> = {
  // async data
  cache, use, mutation

  // forms
  field, form, fieldArray

  // composition
  child, attach, effect, emitter, on

  // scopes (Phase 10)
  provide, inject

  // lifecycle
  onDispose, onSuspend, onResume

  // DI
  deps: TDeps
}
```

The implementation is `buildCtx()` on `ControllerInstance` (`instance.ts:257`). Each method has the same general shape:

1. Create the primitive.
2. Push a `LifecycleEntry` onto `self.entries`.
3. Return the primitive.

`ctx.effect`, `ctx.on`, and the lifecycle hooks also wrap user callbacks in a `dispatchError(rootShared.onError, err, {kind, controllerPath})` shield.

## When is `ctx.*` callable?

Spec §3.4: **any time during the controller's active lifetime, not only the initial factory run**. Dynamically-created primitives integrate into the same `entries` list and dispose with the controller. This lets you e.g. spin up a field inside an effect that responds to schema changes — see the dynamicFormController example in spec §3.4.

Individual primitives also expose `.dispose()` — idempotent, safe to call early. The owning controller will call it again on its own dispose; both calls are no-ops after the first.

## `ctx.deps` — DI surface

Read-only getter on `ctx`. Returns the merged deps object (parent's deps + any overrides from `ctx.child(def, props, { deps })`). The override case spreads into a fresh object; without override, the parent's deps reference is reused (preserves identity equality for tests).

## `ctx.use` overload dispatch

`ctx.use(query, keyOrOptions?)` is implemented as a single function that switches on `query.__olas`:

```ts
const brand = (query as { __olas?: string }).__olas
if (brand === 'infiniteQuery') return createInfiniteUse(...)
return createUse(...)
```

The TS overloads in `Ctx<TDeps>` declare two signatures: one for `Query`, one for `InfiniteQuery`. Consumers see the right return shape.

## `ctx.attach` vs `ctx.child`

`ctx.child(def, props)` returns just `api` — the child's lifecycle is fully owned by the parent (dispose cascades, no manual control). `ctx.attach(def, props)` returns `{ api, dispose, suspend, resume }`: the child is still parent-owned (dispose cascades automatically), but the caller gets explicit handles to tear it down early or freeze/thaw it. `<KeepAlive controller={...}>` in `@kontsedal/olas-react` consumes `{ suspend, resume }` directly. See `controller-instance.md` for cascade semantics.

## What's NOT yet on Ctx

Per spec §20.2: `collection`, `dynamicCollection`, `session`, `lazyChild`. `provide` / `inject` landed in Phase 10 — see [`scope.md`](scope.md) for the semantics and [`modules/react.md`](../modules/react.md) for the React adapter that composes with them.
