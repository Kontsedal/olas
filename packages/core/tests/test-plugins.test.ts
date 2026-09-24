import { describe, expect, test } from 'vitest'
import { createMutation, createQuery, defineQuery } from '../src'
import { defineController } from '../src/controller'
import { createPluginRecorder, createTestController, mockFetchPlugin } from '../src/testing'

describe('mockFetchPlugin', () => {
  const user = defineQuery({
    id: 'tp/user',
    key: (id: number) => ['user', id],
    fetcher: async (_ctx, id: number): Promise<{ id: number; name: string }> => {
      throw new Error(`real fetcher reached for ${id}`)
    },
    retry: 0,
  })
  const def = defineController((ctx) => ({ user: createQuery(ctx, user, () => [1] as [number]) }))

  test('answers with canned data, a function of the attempt, or an error', async () => {
    const mock = mockFetchPlugin({ 'tp/user': { data: { id: 1, name: 'Ada' } } })
    const { api, dispose, waitForIdle } = createTestController(def, { deps: {}, plugins: [mock] })
    await waitForIdle()
    expect(api.user.data.value).toEqual({ id: 1, name: 'Ada' })
    expect(mock.calls.map((c) => [c.query.id, c.args])).toEqual([['tp/user', [1]]])

    mock.respond('tp/user', (c) => ({ id: c.args[0], name: 'from-fn' }))
    await api.user.refetch()
    expect(api.user.data.value).toEqual({ id: 1, name: 'from-fn' })

    mock.respond('tp/user', { error: new Error('boom') })
    await api.user.refetch().catch(() => {})
    expect((api.user.error.value as Error).message).toBe('boom')
    dispose()
  })

  test('an unmocked query fails loudly by default, or reaches its fetcher with passthrough', async () => {
    const strict = createTestController(def, {
      deps: {},
      plugins: [mockFetchPlugin()],
      onError: () => {},
    })
    await strict.waitForIdle()
    expect((strict.api.user.error.value as Error).message).toMatch(
      /no handler for query 'tp\/user'/,
    )
    strict.dispose()

    const open = createTestController(def, {
      deps: {},
      plugins: [mockFetchPlugin({}, { passthrough: true })],
      onError: () => {},
    })
    await open.waitForIdle()
    expect((open.api.user.error.value as Error).message).toMatch(/real fetcher reached/)
    open.dispose()
  })

  test('latency honors cancel', async () => {
    const mock = mockFetchPlugin({ 'tp/user': { data: { id: 1, name: 'late' }, delayMs: 50 } })
    const { api, dispose } = createTestController(def, { deps: {}, plugins: [mock] })
    expect(api.user.isFetching.value).toBe(true)
    api.user.cancel()
    expect(api.user.isFetching.value).toBe(false)
    await new Promise((r) => setTimeout(r, 70))
    expect(api.user.data.value).toBeUndefined()
    dispose()
  })
})

describe('createPluginRecorder', () => {
  test('captures writes, activation and mutation runs in order', async () => {
    const q = defineQuery({ id: 'tp/rec', key: () => [], fetcher: async () => 1 })
    const def = defineController((ctx) => ({
      q: createQuery(ctx, q),
      save: createMutation(ctx, { mutate: async (n: number) => n }),
    }))
    const rec = createPluginRecorder()
    const { api, dispose, waitForIdle } = createTestController(def, {
      deps: {},
      plugins: [rec.plugin],
    })
    await waitForIdle()
    await api.save.run(2)
    expect(rec.events.map((e) => e.hook)).toEqual([
      'onActivate',
      'onWrite',
      'onMutation',
      'onMutation',
    ])
    expect(rec.writes[0]?.source).toBe('fetch')
    expect(rec.mutations.map((e) => e.phase)).toEqual(['start', 'success'])
    rec.clear()
    expect(rec.events).toHaveLength(0)
    dispose()
  })
})
