import type {
  ActivityEvent,
  FetchContext,
  InvalidateEvent,
  MutationEvent,
  OlasPlugin,
  RemoveEvent,
  WriteEvent,
} from './plugin/types'
import { abortableSleep } from './utils'

/** One canned answer for `mockFetchPlugin`: data, or an error to reject with. */
export type MockFetchResponse =
  | { readonly data: unknown; readonly delayMs?: number }
  | { readonly error: unknown; readonly delayMs?: number }

/**
 * How `mockFetchPlugin` answers one query's fetches: a canned response, or a
 * function of the fetch attempt that returns (or resolves) the data, or throws.
 */
export type MockFetchHandler =
  | MockFetchResponse
  | ((context: FetchContext) => unknown | Promise<unknown>)

/** Options for `mockFetchPlugin`. */
export type MockFetchOptions = {
  /**
   * What a query with no handler does. `false` (default) fails its fetch
   * with an error naming the query, so an unmocked request cannot reach the
   * network by accident. `true` lets it run its real fetcher.
   */
  passthrough?: boolean
  /** Latency added to every mocked answer, in ms. Default 0. */
  delayMs?: number
}

/** The plugin `mockFetchPlugin` returns, plus its call log and a way to change answers. */
export type MockFetchPlugin = OlasPlugin & {
  /** Every fetch attempt the plugin answered or passed through, in order. */
  readonly calls: readonly FetchContext[]
  /** Set the handler for a query, mid-test: switch it to an error, say. */
  respond(queryId: string, handler: MockFetchHandler): void
}

/**
 * Answer query fetches without their fetchers: a `wrapFetch` middleware keyed
 * by query `id`. Each attempt, retries included, is recorded in `calls`.
 * Latency honors the fetch's `AbortSignal`, so a cancelled fetch stops
 * waiting.
 *
 * ```ts
 * const api = mockFetchPlugin({
 *   'user/detail': { data: { id: 1, name: 'Ada' } },
 *   'user/list': (ctx) => [{ id: ctx.args[0] }],
 *   'feed': { error: new Error('offline'), delayMs: 20 },
 * })
 * const { api: app } = createTestController(appController, { deps, plugins: [api] })
 * ```
 *
 * One plugin value serves every root it is installed on; `calls` collects
 * them all.
 */
export function mockFetchPlugin(
  handlers: Record<string, MockFetchHandler> = {},
  options: MockFetchOptions = {},
): MockFetchPlugin {
  const table = new Map(Object.entries(handlers))
  const calls: FetchContext[] = []
  return {
    name: 'olas-mock-fetch',
    calls,
    respond(queryId, handler) {
      table.set(queryId, handler)
    },
    setup: () => ({
      async wrapFetch(context, next) {
        calls.push(context)
        const handler = table.get(context.query.id)
        if (handler === undefined) {
          if (options.passthrough === true) return next()
          throw new Error(
            `[olas] mockFetchPlugin: no handler for query '${context.query.id}'. Add one, or ` +
              'pass { passthrough: true } to let unmocked queries run their fetchers.',
          )
        }
        if (typeof handler === 'function') {
          if ((options.delayMs ?? 0) > 0) await abortableSleep(options.delayMs ?? 0, context.signal)
          return handler(context)
        }
        const delay = handler.delayMs ?? options.delayMs ?? 0
        if (delay > 0) await abortableSleep(delay, context.signal)
        if ('error' in handler) throw handler.error
        return handler.data
      },
    }),
  }
}

/** One event `createPluginRecorder` captured, tagged with the hook it came through. */
export type RecordedEvent =
  | { readonly hook: 'onWrite'; readonly event: WriteEvent }
  | { readonly hook: 'onInvalidate'; readonly event: InvalidateEvent }
  | { readonly hook: 'onRemove'; readonly event: RemoveEvent }
  | { readonly hook: 'onActivate'; readonly event: ActivityEvent }
  | { readonly hook: 'onDeactivate'; readonly event: ActivityEvent }
  | { readonly hook: 'onMutation'; readonly event: MutationEvent }

/** What `createPluginRecorder` returns. */
export type PluginRecorder = {
  /** Install it in `plugins`, alongside the plugin under test or alone. */
  readonly plugin: OlasPlugin
  /** Every observation event, in arrival order. */
  readonly events: readonly RecordedEvent[]
  readonly writes: readonly WriteEvent[]
  readonly invalidations: readonly InvalidateEvent[]
  readonly removals: readonly RemoveEvent[]
  readonly mutations: readonly MutationEvent[]
  /** Drop everything recorded so far. */
  clear(): void
}

/**
 * Record every plugin observation event a root emits, for assertions:
 * writes (with their `source` and `origin`), invalidations, removals,
 * activations and mutation runs.
 *
 * ```ts
 * const rec = createPluginRecorder()
 * const { api } = createTestController(def, { deps, plugins: [rec.plugin] })
 * await api.save.run(input)
 * expect(rec.mutations.map((e) => e.phase)).toEqual(['start', 'success'])
 * ```
 */
export function createPluginRecorder(): PluginRecorder {
  const events: RecordedEvent[] = []
  const writes: WriteEvent[] = []
  const invalidations: InvalidateEvent[] = []
  const removals: RemoveEvent[] = []
  const mutations: MutationEvent[] = []
  return {
    events,
    writes,
    invalidations,
    removals,
    mutations,
    clear() {
      for (const list of [events, writes, invalidations, removals, mutations]) list.length = 0
    },
    plugin: {
      name: 'olas-plugin-recorder',
      setup: () => ({
        onWrite(event) {
          events.push({ hook: 'onWrite', event })
          writes.push(event)
        },
        onInvalidate(event) {
          events.push({ hook: 'onInvalidate', event })
          invalidations.push(event)
        },
        onRemove(event) {
          events.push({ hook: 'onRemove', event })
          removals.push(event)
        },
        onActivate(event) {
          events.push({ hook: 'onActivate', event })
        },
        onDeactivate(event) {
          events.push({ hook: 'onDeactivate', event })
        },
        onMutation(event) {
          events.push({ hook: 'onMutation', event })
          mutations.push(event)
        },
      }),
    },
  }
}
