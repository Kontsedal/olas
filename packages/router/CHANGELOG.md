# @kontsedal/olas-router

## 0.0.6

### Patch Changes

- Phase 0.2b — Router adapter package + `RootOptions.scopes` for cross-cutting scope seeding.

  Treated as patch under the 0.x.y line — purely additive across the existing nine packages, plus one new opt-in package.

  **Core — `RootOptions.scopes`**

  - New `scopes?: ReadonlyArray<[Scope<unknown>, unknown]>` option on `createRoot`. Pre-seeds scopes on the root controller instance BEFORE its factory runs so `ctx.inject(...)` resolves them from any descendant. Useful for adapters that want to publish cross-cutting values without forcing the user's root controller to call `ctx.provide(...)`. Later bindings for the same scope override earlier ones.

  **New package: `@kontsedal/olas-router`**

  A generic, router-agnostic adapter for wiring any client-side router (TanStack Router, React Router v6, or your own) into the olas controller tree via three scopes:

  - `RouteParamsScope: Scope<ReadSignal<Record<string, string>>>`
  - `RouteSearchScope: Scope<ReadSignal<Record<string, unknown>>>`
  - `RoutePathnameScope: Scope<ReadSignal<string>>`

  `createRouterAdapter()` returns `{ scopes, Bridge }`. `scopes` plugs into `createRoot({ scopes: adapter.scopes })`; `<adapter.Bridge params={...} search={...} pathname={...}>` mounts inside the React tree and pushes router state into the underlying signals on every change.

  Each `createRouterAdapter()` call mints its own signal store, so per-request SSR roots and isolated test fixtures don't share state. Shallow-equals incoming `params` / `search` records to avoid spurious writes when the router allocates fresh object literals on every render.

  **Next.js is not supported** — see `BACKLOG.md` for the philosophy reasoning.

  **Recipes**

  - `RECIPES.md` Router-integration section rewritten to use `@kontsedal/olas-router`. Both TanStack Router and React Router v6 wire-up patterns shown; each is ~5 lines of user code (call the router's hooks, pass values into `<adapter.Bridge>`).

  Tests: +10 (4 RootOptions.scopes, 6 router adapter), total 590 passing. Typecheck clean. Biome clean (0 errors).

- Updated dependencies
  - @kontsedal/olas-core@0.0.6
