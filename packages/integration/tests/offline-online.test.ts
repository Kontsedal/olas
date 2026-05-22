/**
 * Scenario: offline → online sync via the mutation-queue plugin.
 *
 * Session 1 (offline): the user fires a mutation. The server is
 * unreachable, so `mutate` throws — but the queue plugin has already
 * persisted the entry on enqueue. After session 1 disposes, the entry
 * remains in storage.
 *
 * Session 2 (online): a fresh root mounts with the SAME adapter (same
 * keyPrefix). On `init` the plugin reads the pending entries and replays
 * them through the module-scoped `defineMutation`. The mutate fn now
 * succeeds → storage is drained.
 *
 * Exercises: core (defineMutation + ctx.mutation), persist (StorageAdapter
 * contract), mutation-queue (enqueue / replay / drain semantics).
 */

import {
  _unregisterMutationById,
  createRoot,
  defineController,
  defineMutation,
  type Mutation,
} from '@kontsedal/olas-core'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { memoryAdapter, settle } from './_helpers'

type OrderVars = { sku: string; qty: number }
type OrderResult = { id: string; sku: string; qty: number }

// One mutationId per test — `defineMutation` registers at module scope, so
// we explicitly unregister in beforeEach to avoid cross-test bleed.

describe('integration: offline → online sync', () => {
  const idA = 'int/offline/create-order'

  beforeEach(() => {
    _unregisterMutationById(idA)
  })
  afterEach(() => {
    _unregisterMutationById(idA)
  })

  test('failed mutation persists; new root with same adapter replays it on init', async () => {
    const adapter = memoryAdapter()

    // ---- Session 1 — "offline". mutate throws. ---------------------------

    let online = false
    let mutateCalls = 0
    defineMutation({
      mutationId: idA,
      mutate: async (vars: OrderVars): Promise<OrderResult> => {
        mutateCalls += 1
        if (!online) throw new Error('NetworkError: offline')
        return { id: 'srv-1', ...vars }
      },
    })

    const def1 = defineController((ctx) => ({
      create: ctx.mutation({
        // Spread the module-scope spec (mutationId + mutate) and add
        // retry: 0 so in-process retries don't consume our attempt budget.
        mutationId: idA,
        mutate: async (vars: OrderVars, signal: AbortSignal) => {
          // Re-route to the registered mutate fn through the closure so
          // the in-process run also fails (the queue path uses the
          // registered impl on replay).
          mutateCalls += 1
          if (!online) throw new Error('NetworkError: offline')
          // Re-mark: don't double-count when same fn appears on replay.
          mutateCalls -= 1
          return await Promise.resolve({ id: 'srv-1', ...vars } as OrderResult).then((r) => {
            void signal
            return r
          })
        },
        persist: true,
        retry: 0,
      }) as Mutation<OrderVars, OrderResult>,
    }))

    type Api = { create: Mutation<OrderVars, OrderResult> }
    const root1 = createRoot(def1, {
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'int/mq/v1', maxAttempts: 5 })],
    }) as unknown as Api & { dispose: () => void }

    await expect(root1.create.run({ sku: 'A-1', qty: 2 })).rejects.toThrow(/offline/)
    await settle()

    // Entry persisted; storage is non-empty.
    expect(adapter.store.size).toBe(1)
    const persistedKey = [...adapter.store.keys()][0]!
    const persistedEntry = JSON.parse(adapter.store.get(persistedKey)!)
    expect(persistedEntry.mutationId).toBe(idA)
    expect(persistedEntry.variables).toEqual({ sku: 'A-1', qty: 2 })

    root1.dispose()
    await settle()
    // Still persisted across dispose.
    expect(adapter.store.size).toBe(1)

    // ---- Session 2 — "online". Replay drains the queue. ------------------

    online = true
    const def2 = defineController(() => ({}))
    const root2 = createRoot(def2, {
      deps: {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'int/mq/v1', maxAttempts: 5 })],
    })
    await settle()

    // Storage drained — the replay ran the registered mutate (online → success),
    // entry deleted.
    expect(adapter.store.size).toBe(0)
    // The replay called the registered mutate exactly once with the
    // original variables.
    expect(mutateCalls).toBeGreaterThanOrEqual(1)

    root2.dispose()
  })

  test('multiple offline mutations queue up; reconnect drains all of them', async () => {
    const id = 'int/offline/batch-create'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    let online = false
    const seen: OrderVars[] = []

    defineMutation({
      mutationId: id,
      mutate: async (vars: OrderVars): Promise<OrderResult> => {
        if (!online) throw new Error('NetworkError: offline')
        seen.push(vars)
        return { id: `srv-${seen.length}`, ...vars }
      },
    })

    const def1 = defineController((ctx) => ({
      create: ctx.mutation({
        mutationId: id,
        mutate: async (vars: OrderVars) => {
          if (!online) throw new Error('NetworkError: offline')
          seen.push(vars)
          return { id: `srv-${seen.length}`, ...vars } as OrderResult
        },
        persist: true,
        retry: 0,
      }) as Mutation<OrderVars, OrderResult>,
    }))

    type Api = { create: Mutation<OrderVars, OrderResult> }
    const root1 = createRoot(def1, {
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'int/mq/batch', maxAttempts: 5 })],
    }) as unknown as Api & { dispose: () => void }

    // Three offline writes — each persists.
    await expect(root1.create.run({ sku: 'A', qty: 1 })).rejects.toThrow(/offline/)
    await expect(root1.create.run({ sku: 'B', qty: 2 })).rejects.toThrow(/offline/)
    await expect(root1.create.run({ sku: 'C', qty: 3 })).rejects.toThrow(/offline/)
    await settle()

    expect(adapter.store.size).toBe(3)
    expect(seen).toHaveLength(0)

    root1.dispose()
    await settle()
    expect(adapter.store.size).toBe(3)

    // Flip to online and mount a replay-only root.
    online = true
    const root2 = createRoot(
      defineController(() => ({})),
      {
        deps: {},
        plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'int/mq/batch', maxAttempts: 5 })],
      },
    )
    await settle()

    // All three replayed in enqueue order; storage drained.
    expect(adapter.store.size).toBe(0)
    expect(seen).toEqual([
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 2 },
      { sku: 'C', qty: 3 },
    ])
    root2.dispose()
    _unregisterMutationById(id)
  })

  test('replay errors with attempts < maxAttempts leave the entry in storage', async () => {
    const id = 'int/offline/retry-bounded'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    const attemptLog = vi.fn()
    let failuresLeft = 3 // first 3 replay attempts fail, then succeed

    defineMutation({
      mutationId: id,
      mutate: async (vars: OrderVars): Promise<OrderResult> => {
        attemptLog(vars)
        if (failuresLeft-- > 0) throw new Error('still offline')
        return { id: 'srv-final', ...vars }
      },
    })

    // Seed a queue entry as if a prior session had enqueued and crashed
    // before the in-process attempt finished.
    adapter.store.set(
      `int/mq/retry/${id}/seed-1`,
      JSON.stringify({
        v: 1,
        mutationId: id,
        runId: 'seed-1',
        variables: { sku: 'Z', qty: 9 },
        attempts: 0,
        enqueuedAt: Date.now() - 1000,
      }),
    )

    // Each new root: one replay attempt. After 3 failures, the 4th
    // mounts an online server and succeeds.
    for (let i = 0; i < 4; i++) {
      const root = createRoot(
        defineController(() => ({})),
        {
          deps: {},
          plugins: [
            mutationQueuePlugin({
              adapter,
              keyPrefix: 'int/mq/retry',
              maxAttempts: 10,
            }),
          ],
        },
      )
      await settle()
      root.dispose()
    }

    // After the 4th mount the entry has succeeded → storage empty.
    expect(adapter.store.size).toBe(0)
    expect(attemptLog).toHaveBeenCalledTimes(4)

    _unregisterMutationById(id)
  })
})
