---
name: router
description: "@kontsedal/olas-router — createRouterAdapter returns a plugin that provides the RouteParams/Search/Pathname scopes, and a Bridge that pushes TanStack Router / React Router v6 state into them."
type: module
covers:
  - packages/router/src/adapter.tsx
  - packages/router/src/scopes.ts
  - packages/router/src/index.ts
  - packages/router/README.md
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/router/tests/adapter.test.tsx }
  - { type: tested-by, target: ../../packages/router/tests/ssr.test.tsx }
  - { type: uses, target: controller.md }
  - { type: uses, target: ../entities/scope.md }
last_verified: 2026-09-25
confidence: high
---

# `@kontsedal/olas-router`

A bridge that carries a React router's route state (TanStack Router or React Router v6) into three module-scoped `Scope`s. A controller reads params, search and pathname through `ctx.inject(...)` and never imports the router. SPEC §16.5 ("Routing as a reactive service") describes it.

The public surface is `index.ts`: `createRouterAdapter`, `ROUTER_PLUGIN_NAME`, the types `RouterAdapter` and `RouteState`, and the scopes `RouteParamsScope`, `RouteSearchScope` and `RoutePathnameScope` (`packages/router/src/index.ts:1-7`, `export { createRouterAdapter`).

## Shape

`createRouterAdapter(initial?: RouteState): RouterAdapter` mints an adapter-local `AdapterStore` of three signals, `params`, `search` and `pathname`, seeded from `initial` (`packages/router/src/adapter.tsx:121-126`, `const store: AdapterStore`). It returns `{ plugin, Bridge }` (`packages/router/src/adapter.tsx:165`, `return { plugin, Bridge }`):

- `plugin` is an `OlasPlugin` named `ROUTER_PLUGIN_NAME` (`'olas-router'`). Its `setup` calls `host.provide` once per scope, with this adapter's signal (`packages/router/src/adapter.tsx:130-137`, `host.provide(RouteParamsScope, store.params)`). It goes in `createRoot(def, { plugins: [adapter.plugin] })`. In 0.8 the adapter returned `scopes` for `createRoot({ scopes })`, and the codemod's `root-options` transform rewrites that (`codemod.md`).
- `Bridge` is a React component. It closes over the adapter's store, so it needs no `OlasProvider` above it; `adapter.test.tsx` renders it bare. It pushes its `params`, `search` and `pathname` props into the signals and renders its `children`.

`RouteState = { params?: Record<string, string | undefined>; search?: Record<string, unknown>; pathname?: string }`.

Two adapters never share route state: each call mints its own signals, though the `Scope` definitions are module-global. The test "separate adapter instances are isolated" pins it. One adapter installed in several roots gives them all the same signals, since the route state is one app's (`packages/router/src/adapter.tsx:128-129`, `plugin`). On the server, build one adapter per request.

## The `Bridge`'s write

The `Bridge` writes in one effect, keyed on `[params, search, pathname]` (`packages/router/src/adapter.tsx:153-161`, `useIsomorphicLayoutEffect`):

- A `batch` wraps the three writes, so a consumer of two slots sees no intermediate state.
- `params` and `search` go through `shallowEqual`, since routers allocate a fresh object on every render (`packages/router/src/adapter.tsx:176-185`, `function shallowEqual`). `pathname` is compared with `!==`. The test "shallow-equal short-circuits avoid spurious signal writes" pins it.
- A missing `search` writes the frozen `EMPTY` record, and a missing `pathname` writes `''`. The test "Bridge with no search/pathname props uses empty defaults" pins it.

## The footguns it addresses

- **SSR seeding.** No effect runs during a server render, so the `Bridge` never writes there. Without seeding, the route scopes would hold `{}` and `''` for the whole server render. `createRouterAdapter(initial)` seeds the signals at construction, so server code injects the real route state. The test "seeded initial state is visible on first render, no Bridge/effect (SSR)" reads the scopes with no `Bridge` rendered.
- **First-render emptiness.** On the client, the first render precedes the effect's write. A layout effect shrinks that window without closing it. Guard a route-dependent query with `enabled: () => params.value.id !== undefined`.
- **Server render of the `Bridge`.** The effect is picked once, at import, from `typeof window`: `useLayoutEffect` in a browser, `useEffect` elsewhere (`packages/router/src/adapter.tsx:14`, `useIsomorphicLayoutEffect`). React 18, the floor of the `react: ">=18"` peer range, logs a `console.error` for a `useLayoutEffect` in a server render; React 19 dropped that warning. The sanctioned SSR path seeds and never renders the `Bridge`, but a consumer's shared layout can mount it anyway. `packages/router/tests/ssr.test.tsx` renders it under `renderToString` in the node environment.
- **`params` typing.** `Record<string, string | undefined>` matches React Router, where an optional segment absent from the URL is `undefined`. The test "params tolerate undefined values (React Router optional segments)" pins it.

## Scopes

`scopes.ts` defines the three with `defineScope` (`packages/router/src/scopes.ts:11-13`, `RouteParamsScope`):

| Scope | Value | Scope name |
|---|---|---|
| `RouteParamsScope` | `ReadSignal<Record<string, string \| undefined>>` | `route:params` |
| `RouteSearchScope` | `ReadSignal<Record<string, unknown>>` | `route:search` |
| `RoutePathnameScope` | `ReadSignal<string>` | `route:pathname` |

The plugin provides each one per root. `entities/scope.md` covers the provide and inject mechanism.

## Prefetch in a loader

The README and `RECIPES.md` recommend `root.bindQuery(query).prefetch(...)` in a route loader, on the client too. An unbound `query.prefetch(...)` knows only the roots that already touched the query. A loader usually runs before any controller has used it, and the unbound call then rejects (`packages/core/src/query/actions.ts:61-66`, `prefetch called before any root has subscribed`).
