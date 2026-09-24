/**
 * Storage is state other same-origin code can write. The queue must not let a
 * stored entry pick which mutation runs, replay one forever, or outlive its
 * TTL by claiming a future timestamp.
 */
import { createRoot, defineController, defineMutation, queryEngine } from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { describe, expect, test, vi } from 'vitest'
import { mutationQueuePlugin } from '../src/plugin'
import { PROTOCOL_VERSION, type QueueEntry } from '../src/protocol'

function memoryAdapter(): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: (key) => (store.has(key) ? (store.get(key) as string) : null),
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
    keys: () => [...store.keys()],
  } as StorageAdapter & { store: Map<string, string> }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => queueMicrotask(r))
}

const PREFIX = 'sec/mq'

const entry = (over: Partial<Record<keyof QueueEntry, unknown>> = {}): string =>
  JSON.stringify({
    v: PROTOCOL_VERSION,
    mutationId: 'sec/save',
    runId: 'r1',
    variables: {},
    attempts: 0,
    enqueuedAt: Date.now() - 1_000,
    ...over,
  })

/** Boot a root over `adapter`, as a page load would, and let replay run. */
async function load(adapter: StorageAdapter, options: Record<string, unknown> = {}) {
  const onReplayError = vi.fn()
  const root = createRoot(
    defineController(() => ({})),
    {
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
          keyPrefix: PREFIX,
          onReplayError,
          onWarn: () => {},
          ...options,
        }),
      ],
    },
  )
  await settle()
  await root.waitForIdle()
  root.dispose()
  return { onReplayError }
}

describe('mutation-queue replay against stored data', () => {
  test('an entry naming a mutation that never opted in is dropped, not run', async () => {
    const id = 'sec/delete-account'
    _unregisterMutationById(id)
    const runs = vi.fn(async () => 'deleted')
    defineMutation({ id, mutate: runs }) // no meta.persist
    const adapter = memoryAdapter()
    adapter.store.set(`${PREFIX}/${id}/r1`, entry({ mutationId: id }))
    const { onReplayError } = await load(adapter)
    expect(runs).not.toHaveBeenCalled()
    expect(adapter.store.size).toBe(0)
    expect(onReplayError).toHaveBeenCalledTimes(1)
  })

  test('an entry stored under a key its contents do not name is dropped, not run', async () => {
    const id = 'sec/save'
    _unregisterMutationById(id)
    const runs = vi.fn(async () => 'saved')
    defineMutation({ id, mutate: runs, meta: { persist: true } })
    const adapter = memoryAdapter()
    adapter.store.set(`${PREFIX}/decoy/r1`, entry({ mutationId: id, runId: 'other' }))
    await load(adapter)
    await load(adapter)
    expect(runs).not.toHaveBeenCalled()
    expect(adapter.store.size).toBe(0)
  })

  test('a migration that renames the mutation replays the entry once', async () => {
    const id = 'sec/order-v2'
    _unregisterMutationById(id)
    const runs = vi.fn(async () => 'ordered')
    defineMutation({ id, mutate: runs, meta: { persist: true } })
    const adapter = memoryAdapter()
    adapter.store.set(`${PREFIX}/sec/order/r1`, entry({ v: 0, mutationId: 'sec/order' }))
    const migrate = (raw: unknown) => ({ ...(raw as object), v: PROTOCOL_VERSION, mutationId: id })
    await load(adapter, { migrate })
    await load(adapter, { migrate })
    await load(adapter, { migrate })
    expect(runs).toHaveBeenCalledTimes(1)
    expect(adapter.store.size).toBe(0)
  })

  test('an impossible attempt count or a future timestamp marks the entry malformed', async () => {
    const id = 'sec/save-bounds'
    _unregisterMutationById(id)
    const runs = vi.fn(async () => 'saved')
    defineMutation({ id, mutate: runs, meta: { persist: true } })
    const adapter = memoryAdapter()
    adapter.store.set(`${PREFIX}/${id}/a`, entry({ mutationId: id, runId: 'a', attempts: -1e308 }))
    adapter.store.set(`${PREFIX}/${id}/b`, entry({ mutationId: id, runId: 'b', attempts: 1.5 }))
    adapter.store.set(
      `${PREFIX}/${id}/c`,
      entry({ mutationId: id, runId: 'c', enqueuedAt: Date.now() + 1e12 }),
    )
    adapter.store.set(`${PREFIX}/${id}/d`, entry({ mutationId: id, runId: 'd', seq: 'first' }))
    await load(adapter)
    expect(runs).not.toHaveBeenCalled()
    expect(adapter.store.size).toBe(0)
  })
})
