import { describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import type { QueryClientPlugin, QueryClientPluginApi, SetDataEvent } from '../src/query/plugin'
import type { QuerySubscription } from '../src/query/types'

/**
 * Pin the `QueryClientPlugin` surface (`RootOptions.plugins[]`, `init`,
 * `onSetData`, `onInvalidate`, `onGc`, `applyRemoteSetData` &
 * `applyRemoteInvalidate` round-trips, `isRemote` flag). SPEC §13.2.
 *
 * The cross-tab end-to-end coverage lives in `@olas/cross-tab` tests; this
 * file pins the core hooks the plugin builds on.
 *
 * Note: `query.setData(...)` is a no-op until the query has been bound by
 * at least one `ctx.use(...)` subscription (so a client is registered in
 * `query.__clients`). Tests therefore build a controller that subscribes
 * to the query, then drive `setData` / `invalidate`.
 */

const usersQuery = defineQuery({
  queryId: 'plugin-test/users',
  key: (id: string) => ['user', id],
  fetcher: async (_ctx, id: string) => ({ id, name: `User ${id}` }),
})

const anonymousQuery = defineQuery({
  // No `queryId` — plugin events should be skipped.
  key: (id: string) => ['anon', id],
  fetcher: async (_ctx, id: string) => ({ id }),
})

/**
 * Mount a single-subscription controller for `usersQuery('id-1')` so the
 * root's QueryClient has the query registered. Returns the active id so
 * we can drive `setData`/`invalidate` against keys we know are bound.
 */
function mountUsersRoot(opts: {
  plugins?: QueryClientPlugin[]
  onError?: (err: unknown, ctx: { kind: string }) => void
}) {
  const def = defineController((ctx) => {
    // Subscribe to two ids so subscribedKeys has something to return.
    const user1 = ctx.use(usersQuery, () => ['1' as string])
    const user2 = ctx.use(usersQuery, () => ['2' as string])
    return { user1, user2 } as {
      user1: QuerySubscription<unknown>
      user2: QuerySubscription<unknown>
    }
  })
  return createRoot(def, {
    deps: {},
    plugins: opts.plugins,
    onError: opts.onError as never,
  })
}

describe('QueryClientPlugin', () => {
  test('plugin.init is called once after construction with a working api', () => {
    const init = vi.fn<(api: QueryClientPluginApi) => void>()
    const plugin: QueryClientPlugin = { init }
    const root = mountUsersRoot({ plugins: [plugin] })
    expect(init).toHaveBeenCalledTimes(1)
    const api = init.mock.calls[0]![0]!
    expect(typeof api.applyRemoteSetData).toBe('function')
    expect(typeof api.applyRemoteInvalidate).toBe('function')
    expect(typeof api.subscribedKeys).toBe('function')
    root.dispose()
  })

  test('onSetData fires with isRemote: false on local setData', () => {
    const onSetData = vi.fn<(e: SetDataEvent) => void>()
    const plugin: QueryClientPlugin = { onSetData }
    const root = mountUsersRoot({ plugins: [plugin] })

    usersQuery.setData('1', () => ({ id: '1', name: 'Alice' }))
    expect(onSetData).toHaveBeenCalledTimes(1)
    const event = onSetData.mock.calls[0]![0]!
    expect(event.queryId).toBe('plugin-test/users')
    expect(event.keyArgs).toEqual(['user', '1'])
    expect(event.data).toEqual({ id: '1', name: 'Alice' })
    expect(event.kind).toBe('data')
    expect(event.isRemote).toBe(false)
    root.dispose()
  })

  test('onSetData is NOT fired for queries with no queryId', () => {
    const onSetData = vi.fn<(e: SetDataEvent) => void>()
    const plugin: QueryClientPlugin = { onSetData }
    // Build a controller that ALSO binds anonymousQuery so it has a client.
    const def = defineController((ctx) => {
      ctx.use(usersQuery, () => ['1' as string])
      ctx.use(anonymousQuery, () => ['1' as string])
      return {}
    })
    const root = createRoot(def, { deps: {}, plugins: [plugin] })

    anonymousQuery.setData('1', () => ({ id: '1' }))
    expect(onSetData).not.toHaveBeenCalled()

    // Sanity: queries WITH queryId still fire.
    usersQuery.setData('1', () => ({ id: '1', name: 'X' }))
    expect(onSetData).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('applyRemoteSetData routes through setData and flips isRemote: true', () => {
    let api!: QueryClientPluginApi
    const onSetData = vi.fn<(e: SetDataEvent) => void>()
    const plugin: QueryClientPlugin = {
      init(a) {
        api = a
      },
      onSetData,
    }
    const root = mountUsersRoot({ plugins: [plugin] })

    // mountUsersRoot binds entries for ['user', '1'] and ['user', '2'].
    api.applyRemoteSetData('plugin-test/users', ['user', '2'], { id: '2', name: 'Remote' })
    expect(onSetData).toHaveBeenCalledTimes(1)
    expect(onSetData.mock.calls[0]![0]!.isRemote).toBe(true)
    expect(onSetData.mock.calls[0]![0]!.data).toEqual({ id: '2', name: 'Remote' })
    root.dispose()
  })

  test('applyRemoteSetData is a no-op for unknown queryIds', () => {
    let api!: QueryClientPluginApi
    const onSetData = vi.fn<(e: SetDataEvent) => void>()
    const plugin: QueryClientPlugin = {
      init(a) {
        api = a
      },
      onSetData,
    }
    const root = mountUsersRoot({ plugins: [plugin] })

    api.applyRemoteSetData('plugin-test/never-defined', ['anything'], 'data')
    expect(onSetData).not.toHaveBeenCalled()
    root.dispose()
  })

  test('onInvalidate fires for known queryIds; isRemote tracks origin', () => {
    let api!: QueryClientPluginApi
    const onInvalidate = vi.fn()
    const onSetData = vi.fn()
    const plugin: QueryClientPlugin = {
      init(a) {
        api = a
      },
      onSetData,
      onInvalidate,
    }
    const root = mountUsersRoot({ plugins: [plugin] })

    usersQuery.setData('1', () => ({ id: '1', name: 'X' }))
    onSetData.mockClear()

    usersQuery.invalidate('1')
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    expect(onInvalidate.mock.calls[0]![0]!).toMatchObject({
      queryId: 'plugin-test/users',
      keyArgs: ['user', '1'],
      kind: 'data',
      isRemote: false,
    })

    onInvalidate.mockClear()
    api.applyRemoteInvalidate('plugin-test/users', ['user', '1'])
    expect(onInvalidate).toHaveBeenCalledTimes(1)
    expect(onInvalidate.mock.calls[0]![0]!.isRemote).toBe(true)
    root.dispose()
  })

  test('plugin.dispose is called on root dispose', () => {
    const dispose = vi.fn()
    const plugin: QueryClientPlugin = { dispose }
    const root = mountUsersRoot({ plugins: [plugin] })
    expect(dispose).not.toHaveBeenCalled()
    root.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  test('plugin exceptions route to root onError with kind: plugin', () => {
    const onError = vi.fn()
    const plugin: QueryClientPlugin = {
      onSetData() {
        throw new Error('boom')
      },
    }
    const root = mountUsersRoot({ plugins: [plugin], onError })

    usersQuery.setData('1', () => ({ id: '1', name: 'Z' }))
    expect(onError).toHaveBeenCalledTimes(1)
    expect((onError.mock.calls[0]![0] as Error).message).toBe('boom')
    expect(onError.mock.calls[0]![1].kind).toBe('plugin')
    root.dispose()
  })

  test('subscribedKeys returns currently bound entry keys for a queryId', () => {
    let api!: QueryClientPluginApi
    const plugin: QueryClientPlugin = {
      init(a) {
        api = a
      },
    }
    const root = mountUsersRoot({ plugins: [plugin] })

    // mountUsersRoot subscribes to ['1'] and ['2'] → two bound entries.
    const keys = api.subscribedKeys('plugin-test/users')
    expect(keys.length).toBe(2)
    expect(keys).toEqual(
      expect.arrayContaining([
        ['user', '1'],
        ['user', '2'],
      ]),
    )

    expect(api.subscribedKeys('never-defined')).toEqual([])
    root.dispose()
  })
})
