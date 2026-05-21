---
name: scope
description: Typed cross-tree data slot — defineScope + ctx.provide/inject for hierarchical data without prop-drilling.
type: entity
covers:
  - packages/core/src/scope.ts
  - packages/core/src/controller/instance.ts:427-446
  - packages/core/src/controller/types.ts:158-159
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/scope.test.ts }
  - { type: uses, target: controller-instance.md }
  - { type: related, target: ../modules/controller.md }
last_verified: 2026-05-21
confidence: high
---

# `Scope<T>` — typed cross-tree data

Provided by `ctx.provide(scope, value)` on an ancestor, consumed by `ctx.inject(scope)` anywhere in its subtree. The typed alternative to deps for hierarchical, non-app-wide values (`orgId`, `workspaceId`, etc.). Spec §10.3.

## Shape

```ts
type Scope<T> = {
  readonly __olas: 'scope'
  readonly __id: symbol     // identity — matches across provide/inject
  readonly name?: string    // for error messages only
  readonly default?: T
  readonly hasDefault: boolean
  readonly __t?: T          // phantom — pins T through type inference
}

function defineScope<T>(options?: { default?: T; name?: string }): Scope<T>
```

`defineScope` mints a fresh symbol each call, so two `defineScope<X>()` invocations with identical options are still distinct. Identity is what `provide` / `inject` match on.

`hasDefault` is a separate flag so we can distinguish "no default was passed" from "default: undefined was passed". Both produce `scope.default === undefined`, but only the second hits the default branch in `inject`.

## Resolution algorithm

`ctx.inject(scope)` walks the parent chain starting from the calling instance:

1. Read `node.scopes` (a `Map<symbol, unknown> | null`).
2. If the map has the scope's id, return its value.
3. Otherwise, set `node = node.parent` and repeat.
4. If no ancestor has it: if `scope.hasDefault`, return `scope.default`. Otherwise, throw a `[olas] ctx.inject(): no provider for scope '<name>'` error synchronously during construction.

The walk starts at `self` — a controller can both `provide` and `inject` the same scope; the controller's own provided value wins over an ancestor's. See `scope.test.ts:55-64`.

A deeper provider shadows an ancestor's value for its own subtree without affecting siblings. See `scope.test.ts:68-90`.

## Reactivity

`ctx.provide(scope, value)` stores `value` as-is. There is no internal signal — re-calling `provide(scope, newValue)` overwrites the map entry, but it does NOT notify existing consumers. The typical pattern when reactivity is needed: provide a signal-bearing object once and let consumers subscribe to its signals.

See `scope.test.ts:115-138` for the canonical reactive-scope pattern (`{ theme: signal('light') }` provided once; consumer's `ctx.effect` re-runs on theme change).

## Lifecycle

The `scopes: Map<symbol, unknown> | null` lives on `ControllerInstance` and is lazily created on the first `provide` call. `dispose()` nulls it out so a long-lived root reference doesn't keep big provided values alive after the providing controller is gone.

Rollback (construction throws) also disposes the partial instance — the scopes map dies with it. Children injecting from a disposed ancestor never happens because the walk-up checks the live `parent` reference and disposed parents are already torn down.

## When to use — see spec §10.3's litmus test

Spec §10.3 has the full guidance. The TL;DR: scopes are the most easily abused primitive in the library. Use them for genuinely hierarchical data (`orgId` introduced at the org level, needed by tasks below); reach for props otherwise. The litmus test: "if a junior engineer can't answer 'where does this come from?' in 10 seconds, you've overused scopes".
