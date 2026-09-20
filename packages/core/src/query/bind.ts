import { ctxInternals } from '../controller/internals'
import type { Ctx } from '../controller/types'
import type { InfiniteQuery, InfiniteQueryActions, InfiniteQuerySubscription } from './infinite'
import { createLocalCache, type LocalCacheOptions } from './local'
import { createMutation as createMutationImpl, type Mutation, type MutationSpec } from './mutation'
import type { LocalCache, Query, QueryActions, QuerySubscription, UseOptions } from './types'
import { createInfiniteUse, createUse } from './use'

/**
 * Subscribe this controller to a shared cache entry (§5.2).
 *
 * ```ts
 * const user = createQuery(ctx, userQuery, () => [userId.value])
 * ```
 *
 * Was `createQuery(ctx, ...)`. Needs a query engine on the root:
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
  keyOrOptions?: (() => readonly [...Args]) | UseOptions<Args>,
): QuerySubscription<T>
export function createQuery<Args extends unknown[], TPage, TItem>(
  ctx: Ctx,
  source: InfiniteQuery<Args, TPage, TItem>,
  keyOrOptions?: (() => readonly [...Args]) | UseOptions<Args>,
): InfiniteQuerySubscription<TPage, TItem>
export function createQuery(ctx: Ctx, query: any, keyOrOptions?: any): any {
  const internals = ctxInternals(ctx, 'createQuery')
  internals.assertLive('createQuery')
  const client = internals.requireClient('createQuery')
  const brand = (query as { __olas?: string }).__olas
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
 * const report = createCache(ctx, (signal) => api.report(signal))
 * ```
 *
 * Was `createCache(ctx, ...)`. Unlike `createQuery` this needs **no** query engine:
 * a local cache is not a cache-client entry. It still honours the root's
 * `defaultQueryOptions`, which live on the root rather than on the client so
 * that reading them cannot pull the engine into the bundle.
 */
export function createCache<T>(
  ctx: Ctx,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: LocalCacheOptions<T>,
): LocalCache<T> {
  const internals = ctxInternals(ctx, 'createCache')
  internals.assertLive('createCache')
  // A root declaring `staleTime: 5min` shouldn't have controller-local caches
  // silently fall back to 0. Only the fields `LocalCacheOptions` carries are
  // merged; `retry`/`gcTime`/`networkMode` are not part of its surface.
  const defaults = internals.queryDefaults
  const cache = createLocalCache<T>(fetcher, {
    ...options,
    staleTime: options?.staleTime ?? (defaults.staleTime as number | undefined),
    keepPreviousData:
      options?.keepPreviousData ?? (defaults.keepPreviousData as boolean | undefined),
  })
  internals.register({ kind: 'cleanup', dispose: () => cache.dispose() })
  return cache
}

/**
 * A write owned by this controller's lifetime (§6).
 *
 * ```ts
 * const save = createMutation(ctx, { mutate: (v, signal) => api.save(v, signal) })
 * ```
 *
 * Was `createMutation(ctx, ...)`. Needs a query engine: mutations participate in the
 * root's in-flight accounting, which `waitForIdle()` reads during SSR.
 */
export function createMutation<V, R>(ctx: Ctx, spec: MutationSpec<V, R>): Mutation<V, R> {
  const internals = ctxInternals(ctx, 'createMutation')
  internals.assertLive('createMutation')
  const client = internals.requireClient('createMutation')
  const mutation = createMutationImpl<V, R>(
    spec,
    internals.onError,
    internals.path,
    client.mutationsInflight$,
    internals.devtools as never,
    // Lifecycle hooks for persistable mutations, wired only when
    // `spec.persist === true`. `createMutationImpl` validates the
    // `mutationId` requirement before construction.
    spec.persist === true
      ? {
          emitEnqueue: (ev) => client.emitMutationEnqueue(ev),
          emitSettle: (ev) => client.emitMutationSettle(ev),
        }
      : undefined,
  )
  internals.register({ kind: 'cleanup', dispose: () => mutation.dispose() })
  return mutation
}

/**
 * Bind a query value to this controller's root, for imperative reads and
 * writes outside a subscription (§5.5, §6.4).
 *
 * Was `bindQuery(ctx, ...)`.
 */
export function bindQuery<Args extends unknown[], T>(
  ctx: Ctx,
  query: Query<Args, T>,
): QueryActions<Args, T>
export function bindQuery<Args extends unknown[], TPage, TItem>(
  ctx: Ctx,
  query: InfiniteQuery<Args, TPage, TItem>,
): InfiniteQueryActions<Args, TPage, TItem>
export function bindQuery(ctx: Ctx, query: any): any {
  const internals = ctxInternals(ctx, 'bindQuery')
  internals.assertLive('bindQuery')
  return internals.requireClient('bindQuery').bindQuery(query as never)
}
