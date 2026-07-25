# @kontsedal/olas-router

Router-agnostic bridge for `@kontsedal/olas-core`. Exposes route params / search / pathname as `Scope`-resolved `ReadSignal`s so any controller can `ctx.inject(RouteParamsScope)` and react to URL changes — without controllers ever importing your router.

Works with any client-side React router. TanStack Router and React Router v6 are the wire-ups documented below; the same pattern works for `@reach/router`, your own custom router, or anything that hands you `params` / `search` / `pathname` per render.

**Next.js / RSC is intentionally not supported.** The framework owns navigation and data fetching from outside the React tree; the Olas philosophy is "controllers live above your render tree," which conflicts. See `BACKLOG.md` for the long form.

## Install

```bash
pnpm add @kontsedal/olas-router @kontsedal/olas-core @kontsedal/olas-react @preact/signals-core react
```

## 30-second example (TanStack Router)

```tsx
import { createRoot, defineController, computed } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import {
  createRouterAdapter,
  RouteParamsScope,
  RoutePathnameScope,
} from '@kontsedal/olas-router'
import {
  RouterProvider,
  useLocation,
  useParams,
  useSearch,
} from '@tanstack/react-router'

// 1. Mint the adapter once. Its scopes feed `createRoot`; its `Bridge` mounts
//    inside the React tree and pushes router state into the underlying signals.
const adapter = createRouterAdapter()

// 2. Consume route state from any controller.
const userPage = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const pathname = ctx.inject(RoutePathnameScope)
  const userId = computed(() => params.value.userId)
  // Now react to it — refetch, navigate, log, whatever.
  return { userId, pathname }
})

// 3. Wire scopes at the root.
const root = createRoot(userPage, { deps: {}, scopes: adapter.scopes })

function App() {
  const params = useParams({ strict: false })
  const search = useSearch({ strict: false })
  const { pathname } = useLocation()

  return (
    <OlasProvider root={root}>
      <adapter.Bridge params={params} search={search} pathname={pathname}>
        <RouterProvider router={tanstackRouter} />
      </adapter.Bridge>
    </OlasProvider>
  )
}
```

`adapter.Bridge` is a thin React component that watches its props and writes them into the adapter's signals inside one `batch(...)` — controllers see one update per route change, not three.

## React Router v6

```tsx
import { useLocation, useParams, useSearchParams } from 'react-router-dom'

function RouterShell() {
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

```ts
function createRouterAdapter(initial?: RouteState): RouterAdapter

type RouteState = {
  params?: Record<string, string | undefined>
  search?: Record<string, unknown>
  pathname?: string
}

type RouterAdapter = {
  readonly scopes: ReadonlyArray<readonly [Scope<unknown>, unknown]>
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
```

| Symbol | What |
|---|---|
| `createRouterAdapter(initial?)` | Mints a fresh `{ scopes, Bridge }`. One adapter per root — separate roots (SSR per-request, isolated test fixtures) need separate adapters so they don't share state. Pass `initial` to seed route state for the server render (see SSR below). |
| `adapter.scopes` | Pass to `createRoot({ scopes })`. Resolves the three module-scope `Scope`s to this adapter's adapter-local signals. |
| `adapter.Bridge` | React component. Renders `children`. On every prop change, writes `params` / `search` / `pathname` into the underlying signals inside one `batch(...)`, in a `useLayoutEffect` (runs before paint on the client; does not run on the server — seed with `initial`). |
| `RouteParamsScope` | `ReadSignal<Record<string, string \| undefined>>`. Values are `string \| undefined` (`undefined` = an optional segment absent from the URL, matching React Router). Narrow / guard in the consumer if your router parses to other types. |
| `RouteSearchScope` | `ReadSignal<Record<string, unknown>>`. Values are `unknown` because TanStack Router gives parsed values while React Router v6 gives strings. |
| `RoutePathnameScope` | `ReadSignal<string>`. URL path only — no search, no hash. |

## How it works

The adapter holds three internal signals. `Bridge` is a `useLayoutEffect` that calls `signal.set(...)` for each slot whose value shallow-changed (routers re-allocate `params` / `search` on every render, so a vanilla `Object.is` check would write on every commit). All writes are wrapped in `batch(...)` so a controller depending on multiple slots never observes an intermediate state. `useLayoutEffect` runs before the browser paints, so the pre-Bridge value is visible for at most the very first commit on the client (and not at all on the server if you seed — below).

```
your router  →  <adapter.Bridge params={...} search={...} pathname={...}>
                          ↓ shallowEqual check, then batch():
                  adapter.params.set(next)
                  adapter.search.set(next)
                  adapter.pathname.set(next)
                          ↓
                  ctx.inject(RouteParamsScope).value  → reactive read in any controller
```

### Multiple roots / SSR

`createRouterAdapter()` allocates its signals **per call**. Two roots that both `createRoot({ scopes: makeAdapter().scopes })` get independent route state — vital for per-request SSR isolation and for tests that mount multiple roots in parallel.

**Seed route state on the server.** `Bridge` pushes state in a `useLayoutEffect`, which never runs during SSR. So without seeding, `params` / `search` / `pathname` are empty (`{}` / `''`) for the *entire* server render — a controller that reads `params.value.userId` sees `undefined`, fetches nothing (or the wrong thing), and the server HTML is wrong. Pass `initial` derived from the request URL:

```ts
// server, per request
const adapter = createRouterAdapter({
  params: matchedRouteParams,   // from your server-side router match
  search: parsedSearch,
  pathname: url.pathname,
})
const root = createRoot(appController, { deps, scopes: adapter.scopes })
// ...renderToString(<OlasProvider root={root}>…</OlasProvider>)
```

**First-render footgun (client-only apps).** If you *don't* seed (pure client render), the scopes are empty on the very first commit — before the `Bridge`'s layout effect fires. A controller that reads `params.value.id` at construction gets `undefined` for that one tick. Guard queries so they don't fire against a missing param:

```ts
const params = ctx.inject(RouteParamsScope)
const user = ctx.use(userQuery, () => [params.value.id], {
  enabled: () => params.value.id !== undefined, // don't fetch until the id lands
})
```

Since `params` values are now `string | undefined`, the `enabled` guard is also what the type wants — `params.value.id` is `string | undefined` and the query key should only fire once it's defined.

## Patterns

### Treat params as a derived signal

```ts
const params = ctx.inject(RouteParamsScope)
const userId = computed(() => params.value.userId)
const user = ctx.use(userQuery, () => [userId.value])
```

`computed` collapses param objects to the field you care about, so the query only re-fetches when `userId` itself changes.

### Prefetch in the router loader

```ts
// TanStack Router route definition
const userRoute = createRoute({
  path: '/users/$userId',
  loader: ({ params }) => userQuery.prefetch(params.userId),
})
```

`prefetch(...)` populates the cache before `<adapter.Bridge>` mounts. By the time `ctx.use(userQuery, ...)` fires, the entry is already there and `data.value` is non-null on first read.

## Further reading

- [`../../RECIPES.md`](../../RECIPES.md) — Router recipes section (TanStack, React Router v6, prefetch).
- [`../../SPEC.md`](../../SPEC.md) §16.5 — "Routing is a service in deps" (the broader design rationale).
- [`../core/README.md`](../core/README.md) — `defineScope` and `ctx.inject` mechanics.
