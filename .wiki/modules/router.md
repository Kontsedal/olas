---
name: router
description: "@kontsedal/olas-router — createRouterAdapter bridges TanStack Router / React Router v6 route state into RouteParams/Search/Pathname scopes."
type: module
covers:
  - packages/router/src/adapter.tsx
  - packages/router/src/scopes.ts
  - packages/router/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/router/tests/adapter.test.tsx }
  - { type: uses, target: controller.md }
  - { type: uses, target: ../entities/scope.md }
last_verified: 2026-07-25
confidence: high
---

# `@kontsedal/olas-router`

A framework-neutral bridge that funnels a React router's route state (TanStack Router or React Router v6) into three module-scoped `Scope`s, so controllers read params/search/pathname via `ctx.inject(...)` without importing the router. Public surface (`index.ts`): `createRouterAdapter`, types `RouterAdapter` / `RouteState`, and the scopes `RouteParamsScope` / `RouteSearchScope` / `RoutePathnameScope`. Spec §10 (router bridge).

## Shape

`createRouterAdapter(initial?: RouteState): RouterAdapter` mints an **adapter-local** `AdapterStore` of three signals (`params`, `search`, `pathname`) and returns `{ scopes, Bridge }`:

- `scopes: ReadonlyArray<readonly [Scope<unknown>, unknown]>` — pass to `createRoot({ scopes: adapter.scopes })`. Each `[Scope, value]` binds a module-scoped scope to this adapter's signal, so multiple roots (per-request SSR, isolated tests) don't share route state even though the `Scope` definitions are module-global (`adapter.tsx` `AdapterStore` comment).
- `Bridge` — a React component mounted inside `<OlasProvider>`; it pushes the router's `params` / `search` / `pathname` props into the adapter's signals.

`RouteState = { params?: Record<string, string | undefined>; search?: Record<string, unknown>; pathname?: string }`.

## The two footguns it addresses (T6.6)

- **SSR seeding.** The `Bridge` pushes state in a **client-only `useLayoutEffect`** — it never runs on the server. Without seeding, route-scoped signals would be `{}` / `''` for the ENTIRE server render. `createRouterAdapter(initial)` seeds the signals at construction so server code injects real params/search/pathname (`adapter.tsx:5-17`).
- **First-render emptiness.** Even on the client, the first render precedes the `useLayoutEffect` push (moved from `useEffect` → `useLayoutEffect` in T6.6 to shrink the gap, but not eliminate it). Guard route-dependent queries with `enabled: () => params.value.id !== undefined`.
- **`params` typing.** `Record<string, string | undefined>` — matches React Router, where an optional segment absent from the URL is `undefined` (T6.6 widened it from `string`, killing an internal cast).

## Scopes

`RouteParamsScope` → `Record<string,string|undefined>`, `RouteSearchScope` → `Record<string,unknown>`, `RoutePathnameScope` → `string`. Defined in `scopes.ts` via `defineScope`; resolved per-adapter through the `scopes` array. See `entities/scope.md` for the provide/inject mechanism.
