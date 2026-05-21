import {
  _unregisterMutationById,
  createRoot,
  defineController,
  defineMutation,
  type Mutation,
} from '@kontsedal/olas-core'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mutationQueuePlugin } from '../src/plugin'
import { PROTOCOL_VERSION, type QueueEntry } from '../src/protocol'

/**
 * In-memory `StorageAdapter` with a `keys()` extension so the queue plugin
 * can enumerate pending entries. Lets us snapshot storage state across
 * test phases without going near IndexedDB.
 */
function memoryAdapter(): StorageAdapter & {
  store: Map<string, string>
} {
  const store = new Map<string, string>()
  return {
    store,
    get(key: string) {
      return store.has(key) ? (store.get(key) as string) : null
    },
    set(key: string, value: string) {
      store.set(key, value)
    },
    delete(key: string) {
      store.delete(key)
    },
    keys() {
      return [...store.keys()]
    },
  }
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush()
}

afterEach(() => {
  // Tests reuse mutationIds within the file via deliberate cleanup; isolate.
})

describe('mutationQueuePlugin — enqueue / settle', () => {
  const MUTATION_ID = 'mq-test/enqueue-create'

  beforeEach(() => {
    _unregisterMutationById(MUTATION_ID)
  })

  test('persists an entry on enqueue and deletes on success', async () => {
    const adapter = memoryAdapter()
    const createOrder = defineMutation({
      mutationId: MUTATION_ID,
      mutate: async (vars: { sku: string }) => ({ id: 'srv-1', ...vars }),
    })
    const def = defineController((ctx) => ({
      create: ctx.mutation(createOrder) as Mutation<{ sku: string }, unknown>,
    }))

    type Api = { create: Mutation<{ sku: string }, unknown> }
    const root = createRoot(def, {
      deps: {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/v1' })],
    }) as unknown as Api & { dispose(): void }

    expect(adapter.store.size).toBe(0)

    const promise = root.create.run({ sku: 'A-1' })
    // Synchronously after run, the enqueue event has fired and storage has
    // an entry.
    expect(adapter.store.size).toBe(1)
    const [stored] = [...adapter.store.values()]
    const parsed = JSON.parse(stored as string) as QueueEntry
    expect(parsed.mutationId).toBe(MUTATION_ID)
    expect(parsed.variables).toEqual({ sku: 'A-1' })
    expect(parsed.v).toBe(PROTOCOL_VERSION)

    await promise
    await settle()
    // After success, entry is dropped.
    expect(adapter.store.size).toBe(0)

    root.dispose()
  })

  test('leaves the entry in storage on error so the next reload replays', async () => {
    const id = 'mq-test/enqueue-error'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    const calls = vi.fn()
    const failingMutation = defineMutation({
      mutationId: id,
      mutate: async (_vars: { x: number }) => {
        calls()
        throw new Error('server 500')
      },
    })

    const def = defineController((ctx) => ({
      run: ctx.mutation({ ...failingMutation, retry: 0 }) as Mutation<{ x: number }, unknown>,
    }))
    type Api = { run: Mutation<{ x: number }, unknown> }
    const root = createRoot(def, {
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/err', maxAttempts: 3 })],
    }) as unknown as Api & { dispose(): void }

    await root.run.run({ x: 1 }).catch(() => {})
    await settle()
    // attempts < maxAttempts, so the plugin keeps the entry for a future
    // page-load replay.
    expect(adapter.store.size).toBe(1)
    expect(calls).toHaveBeenCalledTimes(1)

    root.dispose()
  })
})

describe('mutationQueuePlugin — replay on init', () => {
  test('replays pending entries through registered mutations', async () => {
    const id = 'mq-test/replay-happy'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    // Pre-seed an entry as if a previous page load had crashed mid-run.
    const entry: QueueEntry = {
      v: PROTOCOL_VERSION,
      mutationId: id,
      runId: 'run-1',
      variables: { sku: 'A-99' },
      attempts: 0,
      enqueuedAt: Date.now() - 1000,
    }
    adapter.store.set(`test/mq/replay/${id}/run-1`, JSON.stringify(entry))

    const replayCalls: Array<{ sku: string }> = []
    defineMutation({
      mutationId: id,
      mutate: async (vars: { sku: string }) => {
        replayCalls.push(vars)
        return { id: 'srv-9', ...vars }
      },
    })

    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/replay' })],
    })
    await settle()

    expect(replayCalls).toHaveLength(1)
    expect(replayCalls[0]).toEqual({ sku: 'A-99' })
    // Entry should be gone after successful replay.
    expect(adapter.store.size).toBe(0)

    root.dispose()
  })

  test('skips replay when the mutationId is not registered', async () => {
    const adapter = memoryAdapter()
    const entry: QueueEntry = {
      v: PROTOCOL_VERSION,
      mutationId: 'mq-test/orphan',
      runId: 'orphan-1',
      variables: {},
      attempts: 0,
      enqueuedAt: Date.now(),
    }
    adapter.store.set(`test/mq/orphan/mq-test/orphan/orphan-1`, JSON.stringify(entry))

    const errors: Array<{ err: unknown; entry: QueueEntry }> = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/orphan',
          onReplayError: (err, e) => errors.push({ err, entry: e }),
        }),
      ],
    })
    await settle()

    // Entry stays in storage; user gets a structured error so they can
    // either import the missing module or drop the entry.
    expect(adapter.store.size).toBe(1)
    expect(errors).toHaveLength(1)
    expect((errors[0]?.err as Error).message).toMatch(/no registered mutation/)

    root.dispose()
  })

  test('drops entries that hit maxAttempts and surfaces the final error', async () => {
    const id = 'mq-test/replay-give-up'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    const entry: QueueEntry = {
      v: PROTOCOL_VERSION,
      mutationId: id,
      runId: 'run-x',
      variables: {},
      // Already at the cap from a prior page load.
      attempts: 5,
      enqueuedAt: Date.now() - 60_000,
    }
    adapter.store.set(`test/mq/giveup/${id}/run-x`, JSON.stringify(entry))

    defineMutation({
      mutationId: id,
      mutate: async () => 'success',
    })

    const errors: Array<{ err: unknown; entry: QueueEntry }> = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/giveup',
          maxAttempts: 5,
          onReplayError: (err, e) => errors.push({ err, entry: e }),
        }),
      ],
    })
    await settle()

    // Entry dropped, error surfaced.
    expect(adapter.store.size).toBe(0)
    expect(errors).toHaveLength(1)
    expect((errors[0]?.err as Error).message).toMatch(/giving up/)

    root.dispose()
  })

  test('runs per-mutationId replays serially, different ids in parallel', async () => {
    const idA = 'mq-test/serial-A'
    const idB = 'mq-test/serial-B'
    _unregisterMutationById(idA)
    _unregisterMutationById(idB)
    const adapter = memoryAdapter()

    // Two entries for A (must run in order), one for B (runs in parallel).
    const now = Date.now()
    const aEntries = [
      {
        v: PROTOCOL_VERSION,
        mutationId: idA,
        runId: 'a-1',
        variables: 1,
        attempts: 0,
        enqueuedAt: now - 200,
      },
      {
        v: PROTOCOL_VERSION,
        mutationId: idA,
        runId: 'a-2',
        variables: 2,
        attempts: 0,
        enqueuedAt: now - 100,
      },
    ] as QueueEntry[]
    const bEntry: QueueEntry = {
      v: PROTOCOL_VERSION,
      mutationId: idB,
      runId: 'b-1',
      variables: 'b',
      attempts: 0,
      enqueuedAt: now - 150,
    }
    for (const e of [...aEntries, bEntry]) {
      adapter.store.set(`test/mq/serial/${e.mutationId}/${e.runId}`, JSON.stringify(e))
    }

    const aOrder: unknown[] = []
    defineMutation({
      mutationId: idA,
      mutate: async (vars: unknown) => {
        await flush() // give the parallel B run a chance to interleave
        aOrder.push(vars)
      },
    })
    defineMutation({
      mutationId: idB,
      mutate: async (vars: unknown) => vars,
    })

    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/serial' })],
    })
    await settle()

    // A's two entries must have run in enqueuedAt order.
    expect(aOrder).toEqual([1, 2])
    // Both adapter slots emptied.
    expect(adapter.store.size).toBe(0)

    root.dispose()
  })

  test('drops malformed entries on init and reports via onWarn', async () => {
    const adapter = memoryAdapter()
    adapter.store.set('test/mq/bad/mutation/garbage', 'not-json')
    adapter.store.set('test/mq/bad/mutation/missing-fields', JSON.stringify({ v: 1 }))

    const warnings: string[] = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/bad',
          onWarn: (msg) => warnings.push(msg),
        }),
      ],
    })
    await settle()

    expect(adapter.store.size).toBe(0)
    expect(warnings.some((w) => w.includes('malformed'))).toBe(true)
    root.dispose()
  })
})

describe('mutationQueuePlugin — config', () => {
  test('throws on missing keyPrefix', () => {
    const adapter = memoryAdapter()
    expect(() => mutationQueuePlugin({ adapter, keyPrefix: '' })).toThrow(/keyPrefix is required/)
  })

  test('warns and disables replay when adapter has no keys() method', async () => {
    const minimal: StorageAdapter = {
      get: () => null,
      set: () => {},
      delete: () => {},
    }
    const warnings: string[] = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter: minimal,
          keyPrefix: 'test/mq/no-keys',
          onWarn: (msg) => warnings.push(msg),
        }),
      ],
    })
    await settle()
    expect(warnings.some((w) => w.includes('keys()'))).toBe(true)
    root.dispose()
  })

  test('defineMutation throws on empty mutationId', () => {
    expect(() =>
      defineMutation({
        mutationId: '',
        mutate: async () => undefined,
      }),
    ).toThrow(/non-empty `mutationId`/)
  })

  test('ctx.mutation throws when persist: true without mutationId', () => {
    expect(() => {
      const def = defineController((ctx) =>
        ctx.mutation({
          persist: true,
          mutate: async () => undefined,
        }),
      )
      createRoot(def, { deps: {} })
    }).toThrow(/persist: true.*requires.*mutationId/)
  })
})
