import {
  createRoot,
  defineController,
  defineMutation,
  type MutationEvent,
  type OlasPlugin,
  type PluginHost,
  type QueryHost,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { mutationQueuePlugin, PROTOCOL_VERSION, type QueueEntry } from '../src'

// Replay order within one mutation id. `seq` is seeded from `Date.now()`, so
// two tabs that start in the same millisecond mint the same `seq` for
// unrelated entries. The order of such a tie used to be whatever order the
// storage listed its keys in, which differs between adapters and can differ
// between tabs. `runId` now breaks it.

type MemoryAdapter = StorageAdapter & {
  store: Map<string, string>
  keys(): string[]
  /** List keys in reverse insertion order, as another adapter might. */
  reverse: boolean
}

function memoryAdapter(): MemoryAdapter {
  const store = new Map<string, string>()
  const adapter: MemoryAdapter = {
    store,
    reverse: false,
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
    keys: () => (adapter.reverse ? [...store.keys()].reverse() : [...store.keys()]),
  }
  return adapter
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush()
}

const stored = (adapter: MemoryAdapter): QueueEntry[] =>
  [...adapter.store.values()].map((raw) => JSON.parse(raw) as QueueEntry)

/** One tab's queue, driven directly: a run starts and never settles, as a reload cuts it off. */
function tab(plugin: OlasPlugin) {
  const host: PluginHost = {
    deps: {},
    provide() {},
    reportError() {},
    onDispose() {},
    track() {},
    network: { isOnline: () => true, onReconnect: () => () => {}, onFocus: () => () => {} },
    queries: {} as QueryHost,
    mutations: {
      has: () => false,
      get: () => undefined,
      run: () => Promise.reject(new Error('no definitions')),
    },
    debug() {},
  }
  const hooks = plugin.setup(host) ?? {}
  return {
    start(mutationId: string, runId: string, variables: unknown) {
      const mutation = { id: mutationId, meta: { persist: true } }
      const event: MutationEvent = { mutation, runId, variables, phase: 'start', origin: undefined }
      hooks.onMutation?.(event)
      void hooks.wrapMutate?.(
        {
          mutation,
          runId,
          variables,
          signal: new AbortController().signal,
          attempt: 0,
          origin: undefined,
        },
        () => new Promise(() => {}),
      )
    },
    dispose: () => hooks.dispose?.(),
  }
}

/** Replay everything in `adapter` under `prefix`, and return the variables in the order they ran. */
async function replayOrder(id: string, adapter: MemoryAdapter, prefix: string): Promise<unknown[]> {
  _unregisterMutationById(id)
  const ran: unknown[] = []
  defineMutation({
    id,
    mutate: async (vars: unknown) => {
      ran.push(vars)
    },
    meta: { persist: true },
  })
  const root = createRoot(
    defineController(() => ({})),
    {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: prefix })],
    },
  )
  await root.waitForIdle()
  root.dispose()
  return ran
}

/** A copy of `adapter`'s contents, in the same insertion order. */
function copy(adapter: MemoryAdapter, reverse: boolean): MemoryAdapter {
  const out = memoryAdapter()
  for (const [k, v] of adapter.store) out.store.set(k, v)
  out.reverse = reverse
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('replay order — a seq two tabs share', () => {
  test('two tabs that start in the same millisecond replay in one order, whatever order storage lists them in', async () => {
    const id = 'order/same-ms'
    const prefix = 'order/same-ms'
    const adapter = memoryAdapter()
    vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000)
    // Two tabs open in the same millisecond, so their counters start equal.
    // Each enqueues one write before either has listed storage.
    const first = tab(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    const second = tab(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    await settle()
    first.start(id, 'run-b', 'from tab 1')
    second.start(id, 'run-a', 'from tab 2')
    await settle()
    first.dispose()
    second.dispose()
    vi.restoreAllMocks()

    const [one, two] = stored(adapter)
    expect(one?.seq).toBe(two?.seq)

    const forward = await replayOrder(id, copy(adapter, false), prefix)
    const backward = await replayOrder(id, copy(adapter, true), prefix)
    expect(forward).toEqual(['from tab 2', 'from tab 1'])
    expect(backward).toEqual(forward)
  })

  test('ties break by runId, and each tab keeps its own entries in the order it wrote them', async () => {
    const id = 'order/interleaved'
    const prefix = 'order/interleaved'
    const adapter = memoryAdapter()
    vi.spyOn(Date, 'now').mockReturnValue(1_750_000_000_000)
    const first = tab(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    const second = tab(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    await settle()
    first.start(id, 'z-1', 'tab 1, first')
    second.start(id, 'y-1', 'tab 2, first')
    first.start(id, 'a-2', 'tab 1, second')
    second.start(id, 'b-2', 'tab 2, second')
    await settle()
    first.dispose()
    second.dispose()
    vi.restoreAllMocks()

    const ran = await replayOrder(id, copy(adapter, true), prefix)
    expect(ran).toEqual(['tab 2, first', 'tab 1, first', 'tab 1, second', 'tab 2, second'])
  })
})

describe('replay order — entries written by earlier versions', () => {
  test('entries with and without seq still replay, by seq or enqueuedAt, then runId', async () => {
    const id = 'order/legacy'
    const prefix = 'order/legacy'
    const adapter = memoryAdapter()
    const put = (e: Omit<QueueEntry, 'v' | 'mutationId' | 'attempts'>) =>
      adapter.store.set(
        `${prefix}/${id}/${e.runId}`,
        JSON.stringify({ v: PROTOCOL_VERSION, mutationId: id, attempts: 0, ...e }),
      )
    // A 0.8 entry, with `seq`.
    put({ runId: 'c', variables: 'seq 100', enqueuedAt: 90, seq: 100 })
    // Entries from before `seq` existed: ordered by `enqueuedAt`.
    put({ runId: 'b', variables: 'enqueuedAt 100', enqueuedAt: 100 })
    put({ runId: 'a', variables: 'enqueuedAt 50', enqueuedAt: 50 })

    const ran = await replayOrder(id, adapter, prefix)
    // `b` and `c` sort equal on 100; `b` goes first by runId.
    expect(ran).toEqual(['enqueuedAt 50', 'enqueuedAt 100', 'seq 100'])
    expect(adapter.store.size).toBe(0)
  })
})
