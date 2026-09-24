import { BRAND, INTERNAL } from '../brand'
import type { DevtoolsEmitter } from '../devtools'
import type { ErrorHandler } from '../errors'
import type { PluginSet } from '../plugin/host'
import { QueryClient } from './client'
import type { DehydratedState, QueryDefaults } from './types'

/** Options for `queryEngine(...)`. */
export type QueryEngineOptions = {
  /**
   * Defaults for every query, infinite query and `createCache` under a root
   * using this engine. A per-query spec field always overrides its default:
   * `spec.X ?? defaults.X ?? <built-in default>`. Spec §5.9.
   *
   * ```ts
   * queryEngine({ defaults: { staleTime: 5 * 60_000, retry: 1 } })
   * ```
   */
  defaults?: QueryDefaults
}

/** What `createRoot` hands the engine. Internal. */
export type QueryEngineHost = {
  onError: ErrorHandler | undefined
  devtools: DevtoolsEmitter
  deps: Record<string, unknown>
  hydrate: DehydratedState | undefined
  plugins: PluginSet | null
}

/**
 * The query engine — pass one to `createRoot` to give the root a cache:
 *
 * ```ts
 * createRoot(app, { deps, queries: queryEngine({ defaults: { staleTime: 30_000 } }) })
 * ```
 *
 * **Why it is a separate value.** `query/client.ts` is the largest module in
 * the package. This module is the only one that imports `QueryClient` by
 * value, so a root built without `queries` leaves the cache engine, the
 * entry state machine, infinite pagination and the refetch triggers out of
 * the bundle.
 *
 * **It is a definition, not an instance.** Each root that adopts it gets its
 * own `QueryClient`, so one engine value can be hoisted to module scope and
 * shared — by several roots, or by a `HydrationBoundary` that rebuilds its
 * root under StrictMode.
 *
 * **The client is created eagerly**, inside `createRoot`, before plugin setup
 * and the controller factory run, so a plugin's `setup` can already reach the
 * cache. That matters: `mutationQueuePlugin` replays mutations persisted by a
 * previous session from `setup`, which is a startup obligation and not a
 * response to anything the current session does.
 */
export type QueryEngine = {
  readonly [BRAND]: 'queryEngine'
  /** @internal */
  readonly [INTERNAL]: QueryEngineInternals
}

/** @internal What `createRoot` reads off an engine. */
export type QueryEngineInternals = {
  /** The defaults, readable without the client so `createCache` can use them. */
  readonly options: QueryEngineOptions
  /** Called once per adopting root, by `createRoot`. */
  create(host: QueryEngineHost): QueryClient
}

export function queryEngine(options: QueryEngineOptions = {}): QueryEngine {
  return {
    [BRAND]: 'queryEngine',
    [INTERNAL]: {
      options,
      create(host: QueryEngineHost): QueryClient {
        return new QueryClient({
          onError: host.onError,
          devtools: host.devtools,
          deps: host.deps,
          hydrate: host.hydrate,
          defaults: options.defaults,
          plugins: host.plugins,
        })
      },
    },
  }
}
