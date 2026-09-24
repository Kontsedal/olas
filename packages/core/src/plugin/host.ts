import type { AmbientDeps } from '../controller/types'
import type { DevtoolsEmitter } from '../devtools'
import { dispatchError, type ErrorHandler } from '../errors'
import { subscribeReconnect, subscribeWindowFocus } from '../query/focus-online'
import type { Scope } from '../scope'
import type {
  ActivityEvent,
  FetchContext,
  InvalidateEvent,
  MutateContext,
  MutationEvent,
  MutationHost,
  NetworkHost,
  OlasPlugin,
  PluginHooks,
  PluginHost,
  QueryHost,
  RemoveEvent,
  WriteEvent,
} from './types'

/**
 * The query engine's side of the host, supplied by `QueryClient`. Passed in
 * rather than imported so a root without an engine never bundles the client.
 */
export type PluginEngine = {
  queryHost(origin: string): QueryHost
  mutationHost(origin: string): MutationHost
}

type ObserverEvents = {
  onWrite: WriteEvent
  onInvalidate: InvalidateEvent
  onRemove: RemoveEvent
  onActivate: ActivityEvent
  onDeactivate: ActivityEvent
  onMutation: MutationEvent
}

type Installed = {
  readonly name: string
  readonly hooks: PluginHooks
  readonly disposers: Array<() => void>
}

/**
 * One root's installed plugins. Runs their setups, delivers events to them,
 * composes their middleware, and tears them down.
 *
 * Delivery rules (spec §13):
 * - hooks run in install order, each isolated: a throw goes to `onError`
 *   as `kind: 'plugin'` and the next plugin still runs;
 * - nothing is delivered once `close()` has been called, which the root does
 *   before it disposes anything;
 * - `dispose()` runs the plugins' teardown in reverse install order.
 */
export class PluginSet {
  private readonly installed: Installed[] = []
  private readonly fetchWrappers: Installed[] = []
  private readonly mutateWrappers: Installed[] = []
  private readonly pending = new Set<Promise<unknown>>()
  private closed = false
  private disposed = false
  /** True once any installed plugin has `onMutation` or `wrapMutate`. */
  observesMutations = false

  constructor(
    private readonly onError: ErrorHandler | undefined,
    private readonly devtools: DevtoolsEmitter,
  ) {}

  /**
   * Run every plugin's `setup`, in order. Returns the scope bindings the
   * plugins provided. When a setup throws, the plugins already set up are
   * disposed in reverse order and the error is rethrown.
   */
  install(
    plugins: readonly OlasPlugin[],
    context: { deps: AmbientDeps; engine: PluginEngine | null },
  ): Array<readonly [Scope<unknown>, unknown]> {
    const bindings: Array<readonly [Scope<unknown>, unknown]> = []
    const names = new Set<string>()
    for (const plugin of plugins) {
      if (typeof plugin?.name !== 'string' || plugin.name.length === 0) {
        this.dispose()
        throw new TypeError('[olas] every plugin needs a non-empty `name`.')
      }
      if (names.has(plugin.name)) {
        this.dispose()
        throw new Error(
          `[olas] two plugins are named '${plugin.name}'. A plugin's name must be unique in a ` +
            'root: it attributes errors and is the origin stamped on its writes.',
        )
      }
      names.add(plugin.name)
      const disposers: Array<() => void> = []
      let settingUp = true
      const host = this.makeHost(plugin.name, context, disposers, (scope, value) => {
        if (!settingUp) {
          throw new Error(
            `[olas] plugin '${plugin.name}' called host.provide() after setup. Scopes are ` +
              'seeded before the root controller runs, so provide them during setup.',
          )
        }
        bindings.push([scope as Scope<unknown>, value])
      })
      let hooks: PluginHooks | void
      try {
        hooks = plugin.setup(host)
      } catch (err) {
        // The half-set-up plugin still gets its registered disposers run.
        this.installed.push({ name: plugin.name, hooks: {}, disposers })
        this.dispose()
        throw err
      } finally {
        settingUp = false
      }
      const entry: Installed = { name: plugin.name, hooks: hooks ?? {}, disposers }
      this.installed.push(entry)
      if (entry.hooks.wrapFetch) this.fetchWrappers.push(entry)
      if (entry.hooks.wrapMutate) this.mutateWrappers.push(entry)
      if (entry.hooks.onMutation || entry.hooks.wrapMutate) this.observesMutations = true
    }
    return bindings
  }

  private makeHost(
    name: string,
    context: { deps: AmbientDeps; engine: PluginEngine | null },
    disposers: Array<() => void>,
    provide: (scope: Scope<unknown>, value: unknown) => void,
  ): PluginHost {
    const network: NetworkHost = {
      isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
      onReconnect(fn) {
        const off = subscribeReconnect(fn)
        disposers.push(off)
        return off
      },
      onFocus(fn) {
        const off = subscribeWindowFocus(fn)
        disposers.push(off)
        return off
      },
    }
    return {
      get deps() {
        return context.deps
      },
      provide: (scope, value) => provide(scope as Scope<unknown>, value),
      reportError: (err) => this.report(name, err),
      onDispose: (fn) => {
        disposers.push(fn)
      },
      track: (work) => {
        const settled = Promise.resolve(work).then(
          () => {},
          () => {},
        )
        this.pending.add(settled)
        void settled.then(() => this.pending.delete(settled))
      },
      network,
      queries: context.engine?.queryHost(name) ?? null,
      mutations: context.engine?.mutationHost(name) ?? null,
      debug: (payload) => {
        if (!__DEV__ || this.closed) return
        this.devtools.emit({ type: 'plugin:event', plugin: name, payload })
      },
    }
  }

  private report(pluginName: string, err: unknown): void {
    dispatchError(this.onError, err, { kind: 'plugin', controllerPath: [], pluginName })
  }

  /** Deliver an observation event to every plugin that listens for it. */
  emit<K extends keyof ObserverEvents>(hook: K, event: ObserverEvents[K]): void {
    if (this.closed) return
    for (const entry of this.installed) {
      const fn = entry.hooks[hook] as ((e: ObserverEvents[K]) => void) | undefined
      if (fn === undefined) continue
      try {
        fn.call(entry.hooks, event)
      } catch (err) {
        this.report(entry.name, err)
      }
    }
  }

  /** True when some plugin has a hook for `hook` — lets callers skip building events. */
  listens(hook: keyof ObserverEvents): boolean {
    if (this.closed) return false
    for (const entry of this.installed) if (entry.hooks[hook] !== undefined) return true
    return false
  }

  /** Run `base` through every `wrapFetch`, first plugin outermost. */
  wrapFetch(context: FetchContext, base: () => Promise<unknown>): Promise<unknown> {
    return compose(this.fetchWrappers, 'wrapFetch', context, base)
  }

  /** Run `base` through every `wrapMutate`, first plugin outermost. */
  wrapMutate(context: MutateContext, base: () => Promise<unknown>): Promise<unknown> {
    return compose(this.mutateWrappers, 'wrapMutate', context, base)
  }

  get hasFetchWrappers(): boolean {
    return this.fetchWrappers.length > 0
  }

  get hasMutateWrappers(): boolean {
    return this.mutateWrappers.length > 0
  }

  /** Work plugins asked `root.waitForIdle()` to wait for. */
  pendingWork(): Promise<unknown>[] {
    return [...this.pending]
  }

  /** Stop delivering events. The root calls this before disposing anything. */
  close(): void {
    this.closed = true
  }

  /** Tear every plugin down, in reverse install order. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.closed = true
    for (let i = this.installed.length - 1; i >= 0; i--) {
      const entry = this.installed[i] as Installed
      if (entry.hooks.dispose) {
        try {
          entry.hooks.dispose()
        } catch (err) {
          this.report(entry.name, err)
        }
      }
      for (let j = entry.disposers.length - 1; j >= 0; j--) {
        try {
          ;(entry.disposers[j] as () => void)()
        } catch (err) {
          this.report(entry.name, err)
        }
      }
    }
    this.installed.length = 0
    this.fetchWrappers.length = 0
    this.mutateWrappers.length = 0
  }
}

function compose<C>(
  wrappers: readonly Installed[],
  hook: 'wrapFetch' | 'wrapMutate',
  context: C,
  base: () => Promise<unknown>,
): Promise<unknown> {
  let next = base
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const entry = wrappers[i] as Installed
    const wrap = entry.hooks[hook] as (c: C, n: () => Promise<unknown>) => Promise<unknown>
    const inner = next
    next = () => {
      try {
        return Promise.resolve(wrap.call(entry.hooks, context, inner))
      } catch (err) {
        return Promise.reject(err)
      }
    }
  }
  return next()
}

/** Identity helper that types an object literal as an `OlasPlugin`. */
export function definePlugin(plugin: OlasPlugin): OlasPlugin {
  return plugin
}
