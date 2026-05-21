import { batch, type Scope, type Signal, signal } from '@kontsedal/olas-core'
import { type ReactElement, type ReactNode, useEffect } from 'react'
import { RouteParamsScope, RoutePathnameScope, RouteSearchScope } from './scopes'

/**
 * Internal store backing one adapter instance. The signals are written by
 * the Bridge component on every prop change; consumers read them via
 * `ctx.inject(RouteParamsScope)` etc.
 *
 * Each `createRouterAdapter()` call mints its own set so multiple roots
 * (per-request SSR, isolated test fixtures) don't share state. The Scope
 * definitions are module-scoped, but the signals they resolve to are
 * adapter-local.
 */
type AdapterStore = {
  params: Signal<Record<string, string>>
  search: Signal<Record<string, unknown>>
  pathname: Signal<string>
}

/**
 * Result of `createRouterAdapter()`. `scopes` plugs into
 * `createRoot({ scopes: adapter.scopes })`; `Bridge` mounts inside the
 * React tree and pushes router state into the underlying signals on every
 * change.
 */
export type RouterAdapter = {
  readonly scopes: ReadonlyArray<readonly [Scope<unknown>, unknown]>
  readonly Bridge: (props: {
    params: Record<string, string>
    search?: Record<string, unknown>
    pathname?: string
    children?: ReactNode
  }) => ReactElement | null
}

/**
 * Build a router adapter — a paired `{ scopes, Bridge }`.
 *
 * Wire-up:
 *
 * ```tsx
 * import { createRouterAdapter, RouteParamsScope } from '@kontsedal/olas-router'
 *
 * const adapter = createRouterAdapter()
 * const root = createRoot(appController, { deps, scopes: adapter.scopes })
 *
 * function App() {
 *   // TanStack Router:
 *   const params = useParams({ strict: false })
 *   const search = useSearch({ strict: false })
 *   const location = useLocation()
 *
 *   // React Router v6:
 *   // const params = useParams()
 *   // const [sp] = useSearchParams()
 *   // const { pathname } = useLocation()
 *
 *   return (
 *     <OlasProvider root={root}>
 *       <adapter.Bridge params={params} search={search} pathname={location.pathname}>
 *         <YourRoutes />
 *       </adapter.Bridge>
 *     </OlasProvider>
 *   )
 * }
 * ```
 *
 * In any controller:
 *
 * ```ts
 * const params = ctx.inject(RouteParamsScope)
 * const userId = computed(() => params.value.userId)
 * ```
 *
 * The adapter is router-agnostic by design — wire whatever client-side
 * router you use. **Next.js is not supported**; see `BACKLOG.md` for the
 * philosophy reasoning.
 */
export function createRouterAdapter(): RouterAdapter {
  const store: AdapterStore = {
    params: signal<Record<string, string>>({}),
    search: signal<Record<string, unknown>>({}),
    pathname: signal<string>(''),
  }

  const scopes: ReadonlyArray<readonly [Scope<unknown>, unknown]> = [
    [RouteParamsScope as unknown as Scope<unknown>, store.params],
    [RouteSearchScope as unknown as Scope<unknown>, store.search],
    [RoutePathnameScope as unknown as Scope<unknown>, store.pathname],
  ]

  function Bridge(props: {
    params: Record<string, string>
    search?: Record<string, unknown>
    pathname?: string
    children?: ReactNode
  }): ReactElement | null {
    const { params, search, pathname, children } = props
    // Push router state into the underlying signals. `batch` collapses
    // the three writes into one notification round so consumers that
    // depend on multiple slots (e.g. `params` + `pathname`) don't see an
    // intermediate state.
    useEffect(() => {
      batch(() => {
        if (!shallowEqual(store.params.peek(), params)) store.params.set(params)
        const nextSearch = search ?? EMPTY
        if (!shallowEqual(store.search.peek(), nextSearch)) store.search.set(nextSearch)
        const nextPathname = pathname ?? ''
        if (store.pathname.peek() !== nextPathname) store.pathname.set(nextPathname)
      })
    }, [params, search, pathname])
    return (children ?? null) as ReactElement | null
  }

  return { scopes, Bridge }
}

const EMPTY: Record<string, unknown> = Object.freeze({})

/**
 * Shallow-equal for the `params` / `search` records. Routers typically
 * allocate a fresh object on every render, so a vanilla `Object.is` check
 * would write the signal on every commit even when nothing actually
 * changed. Shallow-equal catches the common case (same keys + values).
 */
function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.is(a[k], b[k])) return false
  }
  return true
}
