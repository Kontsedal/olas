import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createEmitter,
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  definePlugin,
  defineQuery,
  type ErrorContext,
  isAbortError,
  type PluginHost,
  queryEngine,
} from '../src'
import {
  createPluginRecorder,
  createTestController,
  fakeAsyncState,
  fakeField,
  mockFetchPlugin,
} from '../src/testing'
// Internal: no public API hands out an AbortSignal without a `reason`.
import { abortableSleep } from '../src/utils'

afterEach(() => {
  vi.useRealTimers()
})

describe('plugin host', () => {
  test('host.reportError reaches onError as kind plugin, named after the plugin', () => {
    const onError = vi.fn()
    let host: PluginHost | undefined
    const root = createRoot(
      defineController(() => ({})),
      {
        deps: {},
        onError,
        plugins: [
          definePlugin({
            name: 'reporter',
            setup(h) {
              host = h
            },
          }),
        ],
      },
    )
    const err = new Error('transport down')
    host?.reportError(err)
    expect(onError).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ kind: 'plugin', pluginName: 'reporter', controllerPath: [] }),
    )
    root.dispose()
  })

  test('host.debug is silent once the root has disposed', () => {
    let host: PluginHost | undefined
    const root = createRoot(
      defineController(() => ({})),
      {
        deps: {},
        plugins: [
          {
            name: 'lane',
            setup(h) {
              host = h
            },
          },
        ],
      },
    )
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => {
      if (e.type === 'plugin:event') events.push(e)
    })
    host?.debug({ before: true })
    root.dispose()
    host?.debug({ after: true })
    expect(events.map((e) => (e.type === 'plugin:event' ? e.payload : null))).toEqual([
      { before: true },
    ])
  })

  test('a throwing dispose hook or disposer reaches onError; the rest still tear down', () => {
    const onError = vi.fn()
    const order: string[] = []
    const root = createRoot(
      defineController(() => ({})),
      {
        deps: {},
        onError,
        plugins: [
          {
            name: 'first',
            setup: (host) => {
              host.onDispose(() => order.push('first disposer'))
              return { dispose: () => order.push('first dispose') }
            },
          },
          {
            name: 'second',
            setup: (host) => {
              host.onDispose(() => order.push('second disposer'))
              host.onDispose(() => {
                throw new Error('disposer boom')
              })
              return {
                dispose: () => {
                  throw new Error('dispose boom')
                },
              }
            },
          },
        ],
      },
    )
    root.dispose()
    expect(order).toEqual(['second disposer', 'first dispose', 'first disposer'])
    expect(
      onError.mock.calls.map(([err, c]) => [
        (err as Error).message,
        (c as ErrorContext).kind,
        (c as ErrorContext).pluginName,
      ]),
    ).toEqual([
      ['dispose boom', 'plugin', 'second'],
      ['disposer boom', 'plugin', 'second'],
    ])
  })

  test('a wrapFetch that throws synchronously fails the fetch with that error', async () => {
    const q = defineQuery({
      id: 'coverage-core/sync-wrap',
      key: () => ['k'],
      fetcher: async () => 'real',
      retry: 0,
    })
    const root = createRoot(
      defineController((ctx) => ({ value: createQuery(ctx, q) })),
      {
        deps: {},
        queries: queryEngine(),
        onError: () => {},
        plugins: [
          {
            name: 'sync-thrower',
            setup: () => ({
              wrapFetch: () => {
                throw new Error('sync wrap boom')
              },
            }),
          },
        ],
      },
    )
    await root.waitForIdle()
    expect((root.api.value.error.value as Error).message).toBe('sync wrap boom')
    expect(root.api.value.data.value).toBeUndefined()
    root.dispose()
  })
})

describe('mockFetchPlugin', () => {
  test('a function handler waits out the plugin-wide delay first', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      id: 'coverage-core/mock-delay',
      key: (n: number) => ['n', n],
      fetcher: async (): Promise<number> => {
        throw new Error('real fetcher reached')
      },
    })
    const handler = vi.fn((ctx: { args: readonly unknown[] }) => (ctx.args[0] as number) * 10)
    const mock = mockFetchPlugin({ 'coverage-core/mock-delay': handler }, { delayMs: 40 })
    const root = createTestController(
      defineController((ctx) => ({ value: createQuery(ctx, q, () => [2] as [number]) })),
      { deps: {}, plugins: [mock] },
    )
    await vi.advanceTimersByTimeAsync(39)
    expect(handler).not.toHaveBeenCalled()
    expect(root.api.value.data.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(root.api.value.data.value).toBe(20)
    root.dispose()
  })
})

describe('createPluginRecorder', () => {
  test('records invalidations, deactivations and removals', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      id: 'coverage-core/recorder',
      key: () => ['k'],
      fetcher: async () => 1,
      gcTime: 10,
    })
    const rec = createPluginRecorder()
    const root = createTestController(
      defineController((ctx) => ({ value: createQuery(ctx, q), handle: bindQuery(ctx, q) })),
      { deps: {}, plugins: [rec.plugin] },
    )
    await vi.advanceTimersByTimeAsync(0)
    await root.api.handle.invalidate()
    expect(rec.invalidations.map((e) => e.query.id)).toEqual(['coverage-core/recorder'])

    root.suspend()
    await vi.advanceTimersByTimeAsync(20)
    expect(rec.removals.map((e) => [e.query.id, e.key])).toEqual([
      ['coverage-core/recorder', ['k']],
    ])
    const hooks = rec.events.map((e) => e.hook)
    expect(hooks).toContain('onInvalidate')
    expect(hooks.indexOf('onDeactivate')).toBeLessThan(hooks.indexOf('onRemove'))
    root.dispose()
  })
})

describe('createTestController', () => {
  test('queries: null builds a root with no query engine', () => {
    const q = defineQuery({
      id: 'coverage-core/no-engine',
      key: () => ['k'],
      fetcher: async () => 1,
    })
    const root = createTestController(
      defineController(() => ({})),
      { deps: {}, queries: null },
    )
    expect(() => root.bindQuery(q)).toThrow(/needs a query engine/)
    expect(root.dehydrate()).toEqual({ version: 1, entries: [] })
    root.dispose()
  })
})

describe('fakeField and fakeAsyncState defaults', () => {
  test('fakeField.subscribeChanges skips the initial value; the default setErrors writes errors', () => {
    const field = fakeField('a')
    const seen: string[] = []
    const off = field.subscribeChanges((v) => seen.push(v))
    field.set('b')
    off()
    field.set('c')
    expect(seen).toEqual(['b'])
    field.setErrors(['server says no'])
    expect(field.errors.value).toEqual(['server says no'])
    expect(field.isValid.value).toBe(false)
  })

  test('fakeAsyncState.cancel is inert by default', () => {
    const state = fakeAsyncState({ data: 5 })
    state.cancel()
    expect(state.data.value).toBe(5)
    expect(state.status.value).toBe('success')
  })
})

describe('createEmitter', () => {
  test('a reporter that throws falls back to console.error; siblings still fire', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const events = createEmitter<number>({
        onError: () => {
          throw new Error('reporter boom')
        },
      })
      const seen: number[] = []
      const boom = new Error('handler boom')
      events.on(() => {
        throw boom
      })
      events.on((n) => seen.push(n))
      events.emit(1)
      expect(seen).toEqual([1])
      expect(error).toHaveBeenCalledWith('[olas] emitter handler threw and reporter threw:', boom)
    } finally {
      error.mockRestore()
    }
  })
})

describe('abortableSleep', () => {
  test('an aborted signal without a reason rejects with a canonical AbortError', async () => {
    const legacy = { aborted: true, reason: undefined } as unknown as AbortSignal
    const err = await abortableSleep(10, legacy).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DOMException)
    expect(isAbortError(err)).toBe(true)
  })
})
