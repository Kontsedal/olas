import { defineScope, type ReadSignal, type Scope } from '@kontsedal/olas-core'

/**
 * Route URL params. Shape matches what a typical router exposes:
 * `{ userId: '42', tab: 'profile' }` etc. Values are `string | undefined` —
 * `undefined` for an optional segment not present in the current URL (matches
 * React Router). If your router parses them to other types, do that in the
 * consumer controller (`computed(() => Number(params.value.id))`), and guard
 * the `undefined` (e.g. `enabled: () => params.value.id !== undefined`).
 */
export const RouteParamsScope: Scope<ReadSignal<Record<string, string | undefined>>> = defineScope<
  ReadSignal<Record<string, string | undefined>>
>({ name: 'route:params' })

/**
 * Parsed search-string params. Values are `unknown` because routers vary:
 * TanStack Router parses numbers / booleans, React Router gives strings.
 * Narrow in the consumer.
 */
export const RouteSearchScope: Scope<ReadSignal<Record<string, unknown>>> = defineScope<
  ReadSignal<Record<string, unknown>>
>({ name: 'route:search' })

/**
 * Current pathname (URL path portion, no search/hash). E.g. `'/users/42'`.
 * Useful for analytics, breadcrumbs, or coarse-grained route-change
 * effects.
 */
export const RoutePathnameScope: Scope<ReadSignal<string>> = defineScope<ReadSignal<string>>({
  name: 'route:pathname',
})
