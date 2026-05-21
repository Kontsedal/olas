import { defineScope, type ReadSignal, type Scope } from '@kontsedal/olas-core'

/**
 * Route URL params. Shape matches what a typical router exposes:
 * `{ userId: '42', tab: 'profile' }` etc. Values are always strings — if
 * your router parses them to other types, do that in the consumer
 * controller (`computed(() => Number(params.value.id))`).
 */
export const RouteParamsScope: Scope<ReadSignal<Record<string, string>>> = defineScope<
  ReadSignal<Record<string, string>>
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
