import { DevtoolsEmitter } from '../devtools'
import { QueryClient } from '../query/client'
import { getFactory } from './define'
import { ControllerInstance, type RootShared } from './instance'
import type { AmbientDeps, ControllerDef, Root, RootOptions } from './types'

const ROOT_METHODS = [
  'dispose',
  'suspend',
  'resume',
  'dehydrate',
  'waitForIdle',
  'applyDehydratedEntry',
  '__debug',
] as const

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
  const queryClient = new QueryClient({
    onError: options.onError,
    hydrate: options.hydrate,
    devtools,
    deps: options.deps as Record<string, unknown>,
    refetchOnWindowFocus: options.refetchOnWindowFocus,
    refetchOnReconnect: options.refetchOnReconnect,
    plugins: options.plugins,
  })
  const rootShared: RootShared = {
    devtools,
    onError: options.onError,
    queryClient,
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
    queryClient.dispose()
    throw err
  }

  if (typeof api !== 'object' || api === null) {
    // Allow primitive APIs in principle but root controls must live somewhere.
    // Wrap in a holder. The declared `Root<Api>` type intersection lies in
    // this branch — `(holder as Api).dispose` won't be present on the
    // primitive itself. Dev-warn so the footgun is visible at first run
    // instead of as a confusing "undefined.value" later.
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(
        '[olas] createRoot: controller returned a non-object api ' +
          `(${api === null ? 'null' : typeof api}). ` +
          'Wrapping as { value: api } so root controls (dispose / suspend / ...) ' +
          "can be attached. Prefer returning an object from a root controller's factory.",
      )
    }
    const holder = { value: api } as unknown as Api
    return attachRootControls(holder, instance, devtools, queryClient)
  }

  return attachRootControls(api, instance, devtools, queryClient)
}

function attachRootControls<Api>(
  api: Api,
  instance: ControllerInstance,
  devtools: DevtoolsEmitter,
  queryClient: QueryClient,
): Root<Api> {
  let suspendTimer: ReturnType<typeof setTimeout> | null = null

  const dispose = () => {
    if (suspendTimer != null) {
      clearTimeout(suspendTimer)
      suspendTimer = null
    }
    instance.dispose()
    queryClient.dispose()
  }

  const suspend = (opts?: { maxIdle?: number }) => {
    instance.suspend()
    if (suspendTimer != null) {
      clearTimeout(suspendTimer)
      suspendTimer = null
    }
    const maxIdle = opts?.maxIdle
    if (maxIdle != null && maxIdle !== Number.POSITIVE_INFINITY) {
      suspendTimer = setTimeout(() => {
        suspendTimer = null
        dispose()
      }, maxIdle)
    }
  }

  const resume = () => {
    if (suspendTimer != null) {
      clearTimeout(suspendTimer)
      suspendTimer = null
    }
    instance.resume()
  }

  const debug = {
    subscribe: (handler: Parameters<DevtoolsEmitter['subscribe']>[0]) =>
      devtools.subscribe(handler),
    queryEntries: () => queryClient.queryEntriesSnapshot(),
  }

  const target = api as Record<string, unknown>
  for (const method of ROOT_METHODS) {
    // Use `in` rather than `Object.hasOwn` so class-based apis with
    // prototype methods like `dispose()` still trigger the conflict
    // detection instead of being silently overwritten by defineProperty.
    if (method in target) {
      throw new Error(
        `[olas] Root controller api defines '${method}' which conflicts with the root controls.`,
      )
    }
  }
  // Lock root controls: writable:false + configurable:false so user code
  // can't `delete api.dispose` (orphaning the root) or shadow them with a
  // typo. The `in`-check above is the friendly preflight; this is the
  // hard fence in case a consumer mutates the api after construction.
  const lock = { enumerable: false, writable: false, configurable: false }
  Object.defineProperty(target, 'dispose', { value: dispose, ...lock })
  Object.defineProperty(target, 'suspend', { value: suspend, ...lock })
  Object.defineProperty(target, 'resume', { value: resume, ...lock })
  Object.defineProperty(target, '__debug', { value: debug, ...lock })
  Object.defineProperty(target, 'dehydrate', {
    value: () => queryClient.dehydrate(),
    ...lock,
  })
  Object.defineProperty(target, 'waitForIdle', {
    value: () => queryClient.waitForIdle(),
    ...lock,
  })
  Object.defineProperty(target, 'applyDehydratedEntry', {
    value: (queryId: string, keyArgs: readonly unknown[], data: unknown, lastUpdatedAt: number) =>
      queryClient.applyDehydratedEntry(queryId, keyArgs, data, lastUpdatedAt),
    ...lock,
  })

  return api as Root<Api>
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
