# @kontsedal/olas-router

Router-agnostic bridge for `@kontsedal/olas-core`. Exposes route params, search and pathname as `Scope`-resolved `ReadSignal`s so any controller can `ctx.inject(RouteParamsScope)` and react to URL changes — without controllers ever importing your router.

Works with any **client-side** React router. TanStack Router and React Router v6 are the wire-ups documented below. The same pattern works for `@reach/router`, your own custom router, or anything that hands you `params`, `search` and `pathname` per render. Next.js and RSC are out of scope by design; see [Scope](#scope-client-side-routers-only) at the bottom.

## Install

```bash
pnpm add @kontsedal/olas-router @kontsedal/olas-core @kontsedal/olas-react @preact/signals-core react
```

## 30-second example (TanStack Router)

```tsx file=olas.tsx
import { computed, createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import {
  createRouterAdapter,
  RouteParamsScope,
  RoutePathnameScope,
} from '@kontsedal/olas-router'
import {
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  useSearch,
} from '@tanstack/react-router'

// 1. Mint the adapter once. Its plugin provides the route scopes to the root;
//    its `Bridge` mounts inside the router and pushes router state into them.
export const adapter = createRouterAdapter()

// 2. Consume route state from any controller.
const userPage = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const pathname = ctx.inject(RoutePathnameScope)
  const userId = computed(() => params.value.userId)
  // Now react to it — refetch, navigate, log, whatever.
  return { userId, pathname }
})

// 3. Install the plugin at the root.
export const root = createRoot(userPage, {
  deps: {},
  queries: queryEngine(),
  plugins: [adapter.plugin],
})

// 4. Mount the Bridge in the root route, where the router's hooks can read it.
function RootLayout() {
  const params = useParams({ strict: false })
  const search = useSearch({ strict: false })
  const { pathname } = useLocation()

  return (
    <adapter.Bridge params={params} search={search} pathname={pathname}>
      <Outlet />
    </adapter.Bridge>
  )
}

export const rootRoute = createRootRoute({ component: RootLayout })
const router = createRouter({ routeTree: rootRoute.addChildren([/* your routes */]) })

export function App() {
  return (
    <OlasProvider root={root}>
      <RouterProvider router={router} />
    </OlasProvider>
  )
}
```

`adapter.Bridge` is a thin React component that watches its props and writes them into the adapter's signals inside one `batch(...)` — controllers see one update per route change, not three.

## React Router v6

```tsx
import { Outlet, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { adapter } from './olas' // the adapter from the example above

export function RouterShell() {
  const params = useParams() as Record<string, string>
  const [searchParams] = useSearchParams()
  const search = Object.fromEntries(searchParams)
  const { pathname } = useLocation()

  return (
    <adapter.Bridge params={params} search={search} pathname={pathname}>
      <Outlet />
    </adapter.Bridge>
  )
}
```

## API

```ts nocheck
function createRouterAdapter(initial?: RouteState): RouterAdapter

type RouteState = {
  params?: Record<string, string | undefined>
  search?: Record<string, unknown>
  pathname?: string
}

type RouterAdapter = {
  readonly plugin: OlasPlugin
  readonly Bridge: (props: {
    params: Record<string, string | undefined>
    search?: Record<string, unknown>
    pathname?: string
    children?: ReactNode
  }) => ReactElement | null
}

// Module-scope scope handles, resolvable from any controller:
const RouteParamsScope:   Scope<ReadSignal<Record<string, string | undefined>>>
const RouteSearchScope:   Scope<ReadSignal<Record<string, unknown>>>
const RoutePathnameScope: Scope<ReadSignal<string>>

const ROUTER_PLUGIN_NAME = 'olas-router'
```

| Symbol | What |
|---|---|
| `createRouterAdapter(initial?)` | Mints a fresh `{ plugin, Bridge }` over its own three signals. Every root the plugin is installed in reads those signals, so use one adapter per app. Separate apps (SSR per request, isolated test fixtures) need separate adapters so they don't share state. Pass `initial` to seed route state for the server render (see SSR below). |
| `adapter.plugin` | Pass to `createRoot({ plugins: [adapter.plugin] })`. Its setup provides the three module-scope `Scope`s, resolved to this adapter's signals. It needs no query engine. A `RootOptions.scopes` binding for the same scope wins, which lets a test seed route state directly. |
| `adapter.Bridge` | React component. Renders `children`. On every prop change, writes `params` / `search` / `pathname` into the underlying signals inside one `batch(...)`, in a `useLayoutEffect` (runs before paint on the client; does not run on the server — seed with `initial`). |
| `RouteParamsScope` | `ReadSignal<Record<string, string \| undefined>>`. Values are `string \| undefined` (`undefined` = an optional segment absent from the URL, matching React Router). Narrow / guard in the consumer if your router parses to other types. |
| `RouteSearchScope` | `ReadSignal<Record<string, unknown>>`. Values are `unknown` because TanStack Router gives parsed values while React Router v6 gives strings. |
| `RoutePathnameScope` | `ReadSignal<string>`. URL path only — no search, no hash. |

## How it works

The adapter holds three internal signals. `Bridge` is a `useLayoutEffect` that calls `signal.set(...)` for each slot whose value shallow-changed. The shallow check matters because routers re-allocate `params` and `search` on every render, so a vanilla `Object.is` check would write on every commit. All writes are wrapped in `batch(...)`, so a controller depending on multiple slots never observes an intermediate state. `useLayoutEffect` runs before the browser paints, so the pre-Bridge value is visible for at most the very first commit on the client, and not at all on the server if you seed.

```
your router  →  <adapter.Bridge params={...} search={...} pathname={...}>
                          ↓ shallowEqual check, then batch():
                  params signal.set(next)
                  search signal.set(next)
                  pathname signal.set(next)
                          ↓
                  ctx.inject(RouteParamsScope).value  → reactive read in any controller
```

### Multiple roots / SSR

`createRouterAdapter()` allocates its signals **per call**. Two roots that each install `createRouterAdapter().plugin` from their own call get independent route state — vital for per-request SSR isolation and for tests that mount multiple roots in parallel.

**Seed route state on the server.** `Bridge` pushes state in a `useLayoutEffect`, which never runs during SSR. Without seeding, `params`, `search` and `pathname` stay empty for the *entire* server render, at `{}` and `''`. A controller that reads `params.value.userId` then sees `undefined`, fetches nothing or the wrong thing, and the server HTML is wrong. Pass `initial` derived from the request URL:

```ts
import { createRoot } from '@kontsedal/olas-core'
import { createRouterAdapter } from '@kontsedal/olas-router'
import { appController } from './app'

// server, per request
export function createRequestRoot(url: URL, matchedRouteParams: Record<string, string>) {
  const adapter = createRouterAdapter({
    params: matchedRouteParams, // from your server-side router match
    search: Object.fromEntries(url.searchParams),
    pathname: url.pathname,
  })
  // ...then renderToString(<OlasProvider root={root}>…</OlasProvider>)
  return createRoot(appController, { deps: {}, plugins: [adapter.plugin] })
}
```

**First-render footgun in client-only apps.** On a pure client render with no seed, the scopes are empty on the very first commit, before the `Bridge`'s layout effect fires. A controller that reads `params.value.id` at construction gets `undefined` for that one tick. Guard queries so they don't fire against a missing param:

```ts file=user.ts
import { createQuery, defineController, defineQuery } from '@kontsedal/olas-core'
import { RouteParamsScope } from '@kontsedal/olas-router'

type User = { id: string; name: string }

export const userQuery = defineQuery({
  id: 'user',
  key: (id: string) => ['user', id],
  fetcher: async ({ signal }, id: string) =>
    (await fetch(`/api/users/${id}`, { signal })).json() as Promise<User>,
})

export const userPage = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const user = createQuery(ctx, userQuery, {
    key: () => [params.value.id ?? ''],
    enabled: () => params.value.id !== undefined, // don't fetch until the id lands
  })
  return { user }
})
```

`params.value.id` is `string | undefined`, so the key needs a fallback to type-check, and `enabled` keeps the query from fetching with that fallback.

## Patterns

### Treat params as a derived signal

```ts
import { computed, createQuery, defineController } from '@kontsedal/olas-core'
import { RouteParamsScope } from '@kontsedal/olas-router'
import { userQuery } from './user'

const profile = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const userId = computed(() => params.value.userId)
  const user = createQuery(ctx, userQuery, {
    key: () => [userId.value ?? ''],
    enabled: () => userId.value !== undefined,
  })
  return { user }
})
```

`computed` collapses param objects to the field you care about, so the query only re-fetches when `userId` itself changes.

### Prefetch in the router loader

```tsx
import { createRoute } from '@tanstack/react-router'
import { root, rootRoute } from './olas'
import { userQuery } from './user'

const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/users/$userId',
  loader: ({ params }: { params: { userId: string } }) =>
    root.bindQuery(userQuery).prefetch(params.userId),
})
```

Bind the query to the root you're prefetching *into*. On the client there is one root, and the bare `userQuery.prefetch(...)` still works. A server handling concurrent requests has a root per request, and an unbound prefetch there rejects rather than guessing whose cache to warm.

`prefetch(...)` populates the cache before the route's component mounts. By the time `createQuery(ctx, userQuery, ...)` fires, the entry is already there and `data.value` is non-null on first read.

## Scope: client-side routers only

Next.js and RSC are intentionally not supported. The framework owns navigation and data fetching from *outside* the React tree, which conflicts with the Olas model — controllers live above your render tree. See [`../../BACKLOG.md`](../../BACKLOG.md) for the long-form reasoning.

## Further reading

- [`../../RECIPES.md`](../../RECIPES.md) — Router recipes section (TanStack, React Router v6, prefetch).
- [SPEC §16.5](../../SPEC.md#165-canonical-patterns) — "Routing is a service in deps" (the broader design rationale).
- [`../core/README.md`](../core/README.md) — `defineScope` and `ctx.inject` mechanics.
