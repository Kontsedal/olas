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
  })
  const rootShared: RootShared = {
    devtools,
    onError: options.onError,
    queryClient,
  }

  const instance = new ControllerInstance(
    null,
    rootShared,
    'root',
    options.deps as Record<string, unknown>,
  )

  // Bootstrap failure throws straight out of createRoot. Spec §12.1.5.
  const api = instance.construct(getFactory(def), props)

  if (typeof api !== 'object' || api === null) {
    // Allow primitive APIs in principle but root controls must live somewhere.
    // Wrap in a holder.
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
  }

  const target = api as Record<string, unknown>
  for (const method of ROOT_METHODS) {
    if (Object.prototype.hasOwnProperty.call(target, method)) {
      throw new Error(
        `[olas] Root controller api defines '${method}' which conflicts with the root controls.`,
      )
    }
  }
  Object.defineProperty(target, 'dispose', {
    value: dispose,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(target, 'suspend', {
    value: suspend,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(target, 'resume', {
    value: resume,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(target, '__debug', {
    value: debug,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(target, 'dehydrate', {
    value: () => queryClient.dehydrate(),
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(target, 'waitForIdle', {
    value: () => queryClient.waitForIdle(),
    enumerable: false,
    configurable: true,
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
