import type { DevtoolsEmitter } from '../devtools'
import type { ErrorHandler } from '../errors'
import { QueryClient } from './client'
import type { QueryClientPlugin } from './plugin'
import type { DefaultQueryOptions, DehydratedState } from './types'

/**
 * Query-engine overrides. Every field here also exists on `RootOptions` and
 * means the same thing; a value passed to `queryEngine(...)` wins. The
 * duplication is a migration affordance — `createRoot`'s existing options keep
 * working, and new code can put query configuration next to the engine that
 * consumes it.
 */
export type QueryEngineOptions = {
  plugins?: QueryClientPlugin[]
  hydrate?: DehydratedState
  refetchOnWindowFocus?: boolean
  refetchOnReconnect?: boolean
  defaultQueryOptions?: DefaultQueryOptions
}

/** What `createRoot` hands the engine. Internal. */
export type QueryEngineHost = {
  onError: ErrorHandler | undefined
  devtools: DevtoolsEmitter
  deps: Record<string, unknown>
  hydrate: DehydratedState | undefined
  refetchOnWindowFocus: boolean | undefined
  refetchOnReconnect: boolean | undefined
  defaultQueryOptions: DefaultQueryOptions | undefined
  plugins: QueryClientPlugin[] | undefined
}

/**
 * Opaque carrier for the query engine. Pass one to `createRoot` to give a root
 * a `QueryClient`:
 *
 * ```ts
 * createRoot(app, { deps, queries: queryEngine() })
 * ```
 *
 * **Why this exists.** `createRoot` used to construct a `QueryClient`
 * unconditionally. `query/client.ts` is the largest module in the package, and
 * a static `new QueryClient(...)` inside `createRoot` meant every consumer
 * shipped the cache engine, the entry state machine, infinite pagination and
 * the refetch triggers — whether or not a single query existed. This module is
 * now the only one that imports `QueryClient` by value, so a root built
 * without `queries` leaves all of it out of the bundle.
 *
 * **The engine is adopted eagerly**, inside `createRoot`, before the
 * controller factory runs. Plugin `init` therefore fires at exactly the moment
 * it always did. That matters: `mutationQueuePlugin` replays mutations
 * persisted by a previous session at `init`, which is a startup obligation and
 * not a response to anything the current session does.
 */
export type QueryEngine = {
  readonly __olas: 'queryEngine'
  /** @internal Called once, by `createRoot`. */
  __create(host: QueryEngineHost): QueryClient
}

export function queryEngine(options: QueryEngineOptions = {}): QueryEngine {
  return {
    __olas: 'queryEngine',
    __create(host: QueryEngineHost): QueryClient {
      return new QueryClient({
        onError: host.onError,
        devtools: host.devtools,
        deps: host.deps,
        hydrate: options.hydrate ?? host.hydrate,
        refetchOnWindowFocus: options.refetchOnWindowFocus ?? host.refetchOnWindowFocus,
        refetchOnReconnect: options.refetchOnReconnect ?? host.refetchOnReconnect,
        defaultQueryOptions: options.defaultQueryOptions ?? host.defaultQueryOptions,
        plugins: options.plugins ?? host.plugins,
      })
    },
  }
}

/**
 * Thrown when a controller reaches for the cache on a root built without an
 * engine. Names the fix rather than failing on a null read.
 */
export function missingQueryEngine(operation: string): Error {
  return new Error(
    `[olas] ${operation} needs a query engine. Pass one to createRoot: ` +
      "createRoot(def, { deps, queries: queryEngine() }) — import { queryEngine } from '@kontsedal/olas-core'.",
  )
}
