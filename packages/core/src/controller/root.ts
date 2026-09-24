import { DevtoolsEmitter } from '../devtools'
import { scheduleExpiry } from '../expiry-timer'
import type { QueryClient } from '../query/client'
import { missingQueryEngine } from '../query/missing-engine'
import type { DehydratedState } from '../query/types'
import { getFactory } from './define'
import { ControllerInstance, type RootShared } from './instance'
import type { AmbientDeps, ControllerDef, Root, RootOptions } from './types'

/**
 * Construct a root controller.
 *
 * Internal: this is the shared engine. The public `createRoot` (props-less)
 * and `createTestController` (props-allowing) both call through here.
 */
export function createRootWithProps<Props, Api, TDeps extends Record<string, unknown>>(
  def: ControllerDef<Props, Api>,
  props: Props,
  options: RootOptions<TDeps>,
): Root<Api> {
  const devtools = new DevtoolsEmitter()
  // The engine is adopted EAGERLY, before the factory runs, so plugin `init`
  // fires exactly when it always did. `mutationQueuePlugin` replays mutations
  // persisted by a previous session at `init` — a startup obligation that must
  // not wait for a controller to happen to touch a query. This module imports
  // `QueryClient` as a TYPE only; `query/engine.ts` is the single value
  // importer, which is what keeps the cache engine out of a query-free bundle.
  const queryClient =
    options.queries?.__create({
      onError: options.onError,
      devtools,
      deps: options.deps as Record<string, unknown>,
      hydrate: options.hydrate,
      plugins: options.plugins,
    }) ?? null
  if (__DEV__ && options.queries === undefined) {
    // These only ever reach a QueryClient, so without an engine they are
    // inert. Silence here would strand mutationQueuePlugin's previous-session
    // replay and discard an SSR payload, both without a symptom.
    if (options.plugins !== undefined && options.plugins.length > 0) {
      console.warn(
        '[olas] createRoot got `plugins` but no `queries` engine — they will not be installed. ' +
          'Pass `queries: queryEngine()`.',
      )
    }
    if (options.hydrate !== undefined) {
      console.warn(
        '[olas] createRoot got `hydrate` but no `queries` engine — the payload is discarded. ' +
          'Pass `queries: queryEngine()`.',
      )
    }
  }
  const rootShared: RootShared = {
    devtools,
    onError: options.onError,
    queryClient,
    queryDefaults: options.queries?.__options.defaults ?? {},
    scopesVersion: { value: 0 },
  }

  const instance = new ControllerInstance(
    null,
    rootShared,
    'root',
    options.deps as Record<string, unknown>,
  )

  // Pre-seed scopes from RootOptions before the factory runs so
  // ctx.inject() resolves them from any descendant. SPEC §10.3.
  if (options.scopes !== undefined && options.scopes.length > 0) {
    instance.seedScopes(options.scopes)
  }

  // Bootstrap failure throws straight out of createRoot. Spec §12.1.5.
  // Tear down the QueryClient and any plugins it spawned (window/storage
  // listeners, transports) before re-throwing so the failure doesn't leak.
  let api: Api
  try {
    api = instance.construct(getFactory(def), props)
  } catch (err) {
    queryClient?.dispose()
    throw err
  }

  return buildRootHandle(api, instance, devtools, queryClient)
}

function buildRootHandle<Api>(
  api: Api,
  instance: ControllerInstance,
  devtools: DevtoolsEmitter,
  queryClient: QueryClient | null,
): Root<Api> {
  /** Cancellation closure from `scheduleExpiry`; `null` = no auto-dispose armed. */
  let suspendTimer: (() => void) | null = null

  const dispose = (): void => {
    if (suspendTimer != null) {
      suspendTimer()
      suspendTimer = null
    }
    instance.dispose()
    queryClient?.dispose()
  }

  const suspend = (opts?: { maxIdle?: number }): void => {
    instance.suspend()
    if (suspendTimer != null) {
      suspendTimer()
      suspendTimer = null
    }
    const maxIdle = opts?.maxIdle
    if (maxIdle != null) {
      // `scheduleExpiry` returns `null` for `Infinity` (stay suspended until
      // something else disposes) and chunks a finite value, so a `maxIdle`
      // above the signed 32-bit limit can't overflow into "dispose on the next
      // tick" — the opposite of asking to idle for a month. §21.5.
      suspendTimer = scheduleExpiry(maxIdle, () => {
        suspendTimer = null
        dispose()
      })
    }
  }

  const resume = (): void => {
    if (suspendTimer != null) {
      suspendTimer()
      suspendTimer = null
    }
    instance.resume()
  }

  // Streaming SSR pushes entries in through `hydrate` before any controller
  // has subscribed. Dropping them silently on an engine-less root would present
  // as "hydration did nothing" with no symptom to chase. `bindQuery` throws in
  // the same situation; this cannot, because the intake runs from a script
  // tag, so it warns.
  const hydrate = (state: DehydratedState): void => {
    if (queryClient === null) {
      if (__DEV__ && state.entries.length > 0) {
        const ids = state.entries.slice(0, 3).map((e) => `'${e.id}'`)
        const more = state.entries.length > 3 ? ` and ${state.entries.length - 3} more` : ''
        console.warn(
          `[olas] hydration payload for ${ids.join(', ')}${more} discarded — this root has ` +
            'no query engine. Pass `queries: queryEngine()` to createRoot.',
        )
      }
      return
    }
    for (const entry of state.entries) {
      queryClient.applyDehydratedEntry(entry.id, entry.key, entry.data, entry.lastUpdatedAt)
    }
  }

  const root: Root<Api> = {
    api,
    bindQuery: ((query: unknown) => {
      if (queryClient === null) throw missingQueryEngine('root.bindQuery')
      return queryClient.bindQuery(query as never)
    }) as Root<Api>['bindQuery'],
    inject: (scope) => instance.resolveScope(scope, 'root.inject'),
    dispose,
    suspend,
    resume,
    // No engine means no cache, so nothing to dehydrate. Returning an empty
    // state beats throwing: an SSR render of a query-free root is legitimate,
    // and the client hydrates the same nothing.
    dehydrate: () => queryClient?.dehydrate() ?? { version: 1 as const, entries: [] },
    hydrate,
    waitForIdle: () => queryClient?.waitForIdle() ?? Promise.resolve(),
    debug: {
      subscribe: (handler) => devtools.subscribe(handler),
      queryEntries: () => queryClient?.queryEntriesSnapshot() ?? [],
    },
  }
  return Object.freeze(root)
}

/**
 * Construct a root controller. Root factories take no props — startup config
 * goes in `deps`.
 */
export function createRoot<Api, TDeps extends Record<string, unknown> = AmbientDeps>(
  def: ControllerDef<void, Api>,
  options: RootOptions<TDeps>,
): Root<Api> {
  return createRootWithProps<void, Api, TDeps>(def, undefined as void, options)
}
