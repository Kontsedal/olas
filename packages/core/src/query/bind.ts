import { BRAND } from '../brand'
import { ctxInternals } from '../controller/internals'
import type { Ctx } from '../controller/types'
import type { BindQueryOptions } from './client'
import type { InfiniteQuery, InfiniteQueryActions, InfiniteQuerySubscription } from './infinite'
import { createLocalCache, type LocalCacheOptions } from './local'
import {
  createMutation as createMutationImpl,
  isMutationDef,
  type Mutation,
  type MutationDef,
  type MutationHooks,
  type MutationSpec,
} from './mutation'
import type {
  FetchCtx,
  LocalCache,
  Query,
  QueryActions,
  QuerySubscription,
  QuerySubscriptionOptions,
} from './types'
import { createInfiniteUse, createUse } from './use'

/**
 * Subscribe this controller to a shared cache entry (§5.2).
 *
 * ```ts
 * const user = createQuery(ctx, userQuery, () => [userId.value])
 * ```
 *
 * Needs a query engine on the root:
 * `createRoot(def, { deps, queries: queryEngine() })`.
 */
export function createQuery<Args extends unknown[], T, U>(
  ctx: Ctx,
  source: Query<Args, T>,
  options: {
    key?: () => readonly [...Args]
    enabled?: () => boolean
    select: (data: T) => U
  },
): QuerySubscription<U>
export function createQuery<Args extends unknown[], T>(
  ctx: Ctx,
  source: Query<Args, T>,
  keyOrOptions?: (() => readonly [...Args]) | QuerySubscriptionOptions<Args>,
): QuerySubscription<T>
export function createQuery<Args extends unknown[], TPage, TItem>(
  ctx: Ctx,
  source: InfiniteQuery<Args, TPage, TItem>,
  keyOrOptions?: (() => readonly [...Args]) | QuerySubscriptionOptions<Args>,
): InfiniteQuerySubscription<TPage, TItem>
export function createQuery(ctx: Ctx, query: any, keyOrOptions?: any): any {
  const internals = ctxInternals(ctx, 'createQuery')
  internals.assertLive('createQuery')
  const client = internals.requireClient('createQuery')
  const brand = (query as { [BRAND]?: string })[BRAND]
  const handle =
    brand === 'infiniteQuery'
      ? createInfiniteUse(client, query as InfiniteQuery<unknown[], unknown, unknown>, keyOrOptions)
      : createUse(client, query as Query<unknown[], unknown>, keyOrOptions)
  internals.register({
    kind: 'subscription-cache',
    dispose: handle.dispose,
    suspend: handle.suspend,
    resume: handle.resume,
  })
  return handle.subscription
}

/**
 * A controller-local cache — one fetcher, no sharing, no cache key (§5.1).
 *
 * ```ts
 * const report = createCache(ctx, ({ signal, deps }) => deps.api.report({ signal }))
 * ```
 *
 * Unlike `createQuery` this needs **no** query engine: a local cache is not a
 * cache-client entry. It still honours the root's
 * `queryEngine({ defaults })`, which the root reads without the client so
 * that reading them cannot pull the engine into the bundle.
 */
export function createCache<T>(
  ctx: Ctx,
  fetcher: (ctx: FetchCtx) => Promise<T>,
  options?: LocalCacheOptions<T>,
): LocalCache<T> {
  const internals = ctxInternals(ctx, 'createCache')
  internals.assertLive('createCache')
  // A root declaring `staleTime: 5min` shouldn't have controller-local caches
  // silently fall back to 0. Only the fields `LocalCacheOptions` carries are
  // merged; `retry`/`gcTime`/`networkMode` are not part of its surface.
  const defaults = internals.queryDefaults
  const cache = createLocalCache<T>(
    fetcher,
    {
      ...options,
      staleTime: options?.staleTime ?? (defaults.staleTime as number | undefined),
      keepPreviousData:
        options?.keepPreviousData ?? (defaults.keepPreviousData as boolean | undefined),
    },
    ctx.deps,
  )
  internals.register({ kind: 'cleanup', dispose: () => cache.dispose() })
  return cache
}

/**
 * A write owned by this controller's lifetime (§6). Either inline:
 *
 * ```ts
 * const save = createMutation(ctx, {
 *   mutate: (draft: Draft, { signal, deps }) => deps.api.save(draft, { signal }),
 * })
 * ```
 *
 * or from a module-scope `defineMutation(...)`, with this controller's
 * lifecycle hooks layered on:
 *
 * ```ts
 * const place = createMutation(ctx, createOrder, { onSuccess: () => toast('Placed') })
 * ```
 *
 * Needs a query engine: mutations participate in the root's in-flight
 * accounting, which `waitForIdle()` reads during SSR.
 */
export function createMutation<V, R>(
  ctx: Ctx,
  def: MutationDef<V, R>,
  hooks?: MutationHooks<V, R>,
): Mutation<V, R>
export function createMutation<V, R>(ctx: Ctx, spec: MutationSpec<V, R>): Mutation<V, R>
export function createMutation<V, R>(
  ctx: Ctx,
  specOrDef: MutationSpec<V, R> | MutationDef<V, R>,
  hooks?: MutationHooks<V, R>,
): Mutation<V, R> {
  const internals = ctxInternals(ctx, 'createMutation')
  internals.assertLive('createMutation')
  const client = internals.requireClient('createMutation')
  const spec: MutationSpec<V, R> = isMutationDef(specOrDef)
    ? { ...specOrDef, ...hooks }
    : (specOrDef as MutationSpec<V, R>)
  const mutation = createMutationImpl<V, R>(
    spec,
    internals.onError,
    internals.path,
    client.mutationsInflight$,
    internals.devtools as never,
    // Present only when some plugin observes mutations; each decides from
    // the run's `meta` whether it concerns them.
    client.mutationLifecycle(),
    ctx.deps,
  )
  internals.register({ kind: 'cleanup', dispose: () => mutation.dispose() })
  return mutation
}

/**
 * Bind a query value to this controller's root, for imperative reads and
 * writes outside a subscription (§5.5, §6.4). `options.origin` tags the
 * handle's writes for plugins.
 */
export function bindQuery<Args extends unknown[], T>(
  ctx: Ctx,
  query: Query<Args, T>,
  options?: BindQueryOptions,
): QueryActions<Args, T>
export function bindQuery<Args extends unknown[], TPage, TItem>(
  ctx: Ctx,
  query: InfiniteQuery<Args, TPage, TItem>,
  options?: BindQueryOptions,
): InfiniteQueryActions<Args, TPage, TItem>
export function bindQuery(ctx: Ctx, query: any, options?: BindQueryOptions): any {
  const internals = ctxInternals(ctx, 'bindQuery')
  internals.assertLive('bindQuery')
  return internals.requireClient('bindQuery').bindQuery(query as never, options)
}
