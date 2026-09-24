import { INTERNAL } from '../brand'
import { DevtoolsEmitter } from '../devtools'
import { scheduleExpiry } from '../expiry-timer'
import { PluginSet } from '../plugin/host'
import type { BindQueryOptions, QueryClient } from '../query/client'
import { missingQueryEngine } from '../query/missing-engine'
import type { DehydratedState } from '../query/types'
import type { Scope } from '../scope'
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
  const deps = options.deps as Record<string, unknown>
  const plugins =
    options.plugins !== undefined && options.plugins.length > 0
      ? new PluginSet(options.onError, devtools)
      : null
  // The client is created EAGERLY, before any plugin setup or controller
  // factory, so a plugin's setup can already reach the cache — the mutation
  // queue replays a previous session's writes from there. This module imports
  // `QueryClient` as a TYPE only; `query/engine.ts` is the single value
  // importer, which is what keeps the cache engine out of a query-free bundle.
  const queryClient =
    options.queries?.[INTERNAL].create({
      onError: options.onError,
      devtools,
      deps,
      hydrate: options.hydrate,
      plugins,
    }) ?? null
  if (__DEV__ && options.queries === undefined && options.hydrate !== undefined) {
    // Only a QueryClient reads it, so without an engine it is inert. Silence
    // here would discard an SSR payload without a symptom.
    console.warn(
      '[olas] createRoot got `hydrate` but no `queries` engine — the payload is discarded. ' +
        'Pass `queries: queryEngine()`.',
    )
  }
  const rootShared: RootShared = {
    devtools,
    onError: options.onError,
    queryClient,
    queryDefaults: options.queries?.[INTERNAL].options.defaults ?? {},
    scopesVersion: { value: 0 },
  }

  const instance = new ControllerInstance(null, rootShared, 'root', deps)

  // Plugins set up in order, before the factory, so a scope a plugin provides
  // is visible to every controller. A setup throw disposes the plugins already
  // set up (PluginSet.install does that) and the client, then propagates:
  // a bootstrap failure, like a factory throw (spec §12.1.5).
  if (plugins !== null && options.plugins !== undefined) {
    let provided: ReadonlyArray<readonly [Scope<unknown>, unknown]>
    try {
      provided = plugins.install(options.plugins, {
        deps: deps as AmbientDeps,
        engine: queryClient,
      })
    } catch (err) {
      queryClient?.dispose()
      throw err
    }
    if (provided.length > 0) instance.seedScopes(provided)
  }

  // Explicit root scopes seed after the plugins', so they win — a test can
  // stand a fake in for a plugin's service this way. SPEC §10.3.
  if (options.scopes !== undefined && options.scopes.length > 0) {
    instance.seedScopes(options.scopes)
  }

  // Bootstrap failure throws straight out of createRoot. Spec §12.1.5.
  // Tear down the plugins and the client before re-throwing so the failure
  // doesn't leak their listeners and transports.
  let api: Api
  try {
    api = instance.construct(getFactory(def), props)
  } catch (err) {
    plugins?.dispose()
    queryClient?.dispose()
    throw err
  }

  return buildRootHandle(api, instance, devtools, queryClient, plugins)
}

function buildRootHandle<Api>(
  api: Api,
  instance: ControllerInstance,
  devtools: DevtoolsEmitter,
  queryClient: QueryClient | null,
  plugins: PluginSet | null,
): Root<Api> {
  /** Cancellation closure from `scheduleExpiry`; `null` = no auto-dispose armed. */
  let suspendTimer: (() => void) | null = null

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (suspendTimer != null) {
      suspendTimer()
      suspendTimer = null
    }
    // Plugins stop hearing events first, so nothing the teardown itself
    // causes (entries releasing, runs cancelling) reaches a plugin that is
    // about to be disposed. Then controllers, then the plugins in reverse
    // install order, then the cache.
    plugins?.close()
    instance.dispose()
    plugins?.dispose()
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
    bindQuery: ((query: unknown, options?: BindQueryOptions) => {
      if (queryClient === null) throw missingQueryEngine('root.bindQuery')
      return queryClient.bindQuery(query as never, options)
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
    waitForIdle: async () => {
      // Plugin work (a replay, a restore) can start fetches, and a fetch
      // settling can start plugin work, so settle both until neither moves.
      for (let round = 0; round < 100; round++) {
        await queryClient?.waitForIdle()
        const work = plugins?.pendingWork() ?? []
        if (work.length === 0) return
        await Promise.all(work)
      }
      throw new Error('[olas] waitForIdle: plugin work kept restarting for 100 rounds')
    },
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
