---
name: no-react-adapter-yet
description: Historical — Phase 10 was deferred at v1 minimum; superseded when @kontsedal/olas-react landed.
type: decision
covers:
  - packages/react/src/index.ts
  - packages/react/package.json
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: supersedes, target: ../modules/react.md }
last_verified: 2026-05-18
confidence: high
---

> **Superseded** — Phase 10 has landed. The current state of the adapter is documented in [`modules/react.md`](../modules/react.md); the entity for scopes is [`entities/scope.md`](../entities/scope.md); the end-to-end flow is in [`flows/use-root.md`](../flows/use-root.md). This page is kept for history — it captures *why* the adapter was originally deferred and what was prepared in advance.

# `@kontsedal/olas-react` is empty (Phase 10 deferred)

## The choice

The user scoped the initial implementation to phases 0–9 and 11–12 (per spec §22's "v1 minimum"). Phase 10 (scopes + React adapter) was explicitly out of scope. `packages/react/` exists with `package.json`, `tsconfig.json`, `tsdown.config.ts`, and a stub `src/index.ts` that exports `{}`.

## What Phase 10 needs to deliver

Per spec §10.3 + §20.10:

- **Scopes** — `defineScope<T>(opts?)`, `ctx.provide(scope, value)`, `ctx.inject(scope)`. Typed cross-tree data slots.
- **React adapter**:
  - `OlasProvider({ root, children })` — context provider.
  - `useRoot()` — resolves the root from context.
  - `useController(root)` — back-compat alias.
  - `use(signal)` — single-signal subscription via `useSyncExternalStore`.
  - `useQuery(subscription)` — bundles 8 `AsyncState` signals into one render trigger.
  - `useField(field)` — bundles `Field<T>` signals + methods.
  - `<KeepAlive>` and `useSuspendOnHidden(ctrl)` — opt-in suspension wrappers.

## What's already prepared

The core deliberately ships hooks the React adapter needs:

- `root.__debug.subscribe(handler)` — devtools bus already plumbed.
- Every signal exposes `.value` (get-and-track), `.peek()` (untracked), `.subscribe(handler)` (initial + change). The React adapter will wrap `subscribe`+`peek` in `useSyncExternalStore`.
- `Field<T>` extends `ReadSignal<T>` so `use(field)` returns `T` directly.
- `readOnly(signal)` exists in `signals/readonly.ts` as an internal helper — the React adapter can use it if needed.

## What's NOT prepared

- No `defineScope` / `ctx.provide` / `ctx.inject` machinery yet. Adding scopes requires a small extension to `RootShared` (or `ControllerInstance`) to walk parent chain for `inject`, plus storage on the instance for provided values.
- No example app — there's no integration test that drives a controller through a real React component yet.

## Why decouple this from the core

The core is framework-agnostic by design (spec §1). The React adapter is ~200 lines on `useSyncExternalStore`; the Vue adapter would be similar against `ref`; the Svelte adapter wraps as a store. Building the core without an adapter forces the boundary to be clean. The trade-off is that there's no "out of the box" UI story until Phase 10 lands.

## Implementation note for the future

When Phase 10 lands, add:
- `.wiki/modules/react.md`
- `.wiki/entities/scope.md`
- `.wiki/flows/use-root.md` (provider → context → hook)

Test ordering: drive scopes in `@kontsedal/olas-core` first (which needs `ctx.provide` / `ctx.inject` + `ControllerInstance` parent-chain walks). Then add the React adapter as a thin layer on top.
