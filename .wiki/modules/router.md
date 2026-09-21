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
  - { type: tested-by, target: ../../packages/router/tests/ssr.test.tsx }
  - { type: uses, target: controller.md }
  - { type: uses, target: ../entities/scope.md }
last_verified: 2026-09-21
confidence: high
---

# `@kontsedal/olas-router`

A framework-neutral bridge that funnels a React router's route state (TanStack Router or React Router v6) into three module-scoped `Scope`s, so controllers read params/search/pathname via `ctx.inject(...)` without importing the router. Public surface (`index.ts`): `createRouterAdapter`, types `RouterAdapter` and `RouteState`, and the scopes `RouteParamsScope`, `RouteSearchScope` and `RoutePathnameScope`. Spec §10 (router bridge).

## Shape

`createRouterAdapter(initial?: RouteState): RouterAdapter` mints an **adapter-local** `AdapterStore` of three signals (`params`, `search`, `pathname`) and returns `{ scopes, Bridge }`:

- `scopes: ReadonlyArray<readonly [Scope<unknown>, unknown]>` — pass to `createRoot({ scopes: adapter.scopes })`. Each `[Scope, value]` binds a module-scoped scope to this adapter's signal. Multiple roots, whether per-request SSR or isolated tests, therefore do not share route state, even though the `Scope` definitions are module-global. See the `AdapterStore` comment in `adapter.tsx`.
- `Bridge` — a React component mounted inside `<OlasProvider>`; it pushes the router's `params`, `search` and `pathname` props into the adapter's signals.

`RouteState = { params?: Record<string, string | undefined>; search?: Record<string, unknown>; pathname?: string }`.

## The two footguns it addresses (T6.6)

- **SSR seeding.** The `Bridge` pushes state in a **client-only layout effect** — no effect of either kind runs on the server. Without seeding, route-scoped signals would be `{}` and `''` for the ENTIRE server render. `createRouterAdapter(initial)` seeds the signals at construction so server code injects real params/search/pathname (`adapter.tsx:5-17`).
- **First-render emptiness.** Even on the client, the first render precedes the layout-effect push (moved from `useEffect` → `useLayoutEffect` in T6.6 to shrink the gap, but not eliminate it). Guard route-dependent queries with `enabled: () => params.value.id !== undefined`.
- **Server render of the `Bridge`.** The effect is chosen by environment — `useLayoutEffect` when `typeof window !== 'undefined'`, `useEffect` otherwise (`adapter.tsx`). React 18, the floor of the `react: ">=18"` peer range, warns on `console.error` for a `useLayoutEffect` reached during a server render; React 19 dropped that warning. The sanctioned path still seeds and never renders the `Bridge` on the server, but a consumer's shared layout mounts it anyway. `packages/router/tests/ssr.test.tsx` renders it under `renderToString` in the node environment (0.9 review).
- **`params` typing.** `Record<string, string | undefined>` — matches React Router, where an optional segment absent from the URL is `undefined` (T6.6 widened it from `string`, killing an internal cast).

## Scopes

`RouteParamsScope` → `Record<string,string|undefined>`, `RouteSearchScope` → `Record<string,unknown>`, `RoutePathnameScope` → `string`. Defined in `scopes.ts` via `defineScope`; resolved per-adapter through the `scopes` array. See `entities/scope.md` for the provide/inject mechanism.
