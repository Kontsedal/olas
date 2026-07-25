import { createRoot, defineController, defineMutation, type Mutation } from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
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

// ─── T6.2: previously-untested option surface + the three disqualifiers ──────

/** Stub `navigator`/`window` so replay's online-gate + reconnect listener are
 *  exercisable in the node test env. Returns controls to go online + restore. */
function stubOnlineEnv(initialOnline: boolean) {
  const listeners = new Map<string, Set<() => void>>()
  const nav = { onLine: initialOnline }
  const win = {
    addEventListener: (ev: string, cb: () => void) => {
      const s = listeners.get(ev) ?? new Set<() => void>()
      s.add(cb)
      listeners.set(ev, s)
    },
    removeEventListener: (ev: string, cb: () => void) => listeners.get(ev)?.delete(cb),
  }
  // `navigator` is a getter-only global in node — `vi.stubGlobal` overrides it
  // via defineProperty; `vi.unstubAllGlobals()` restores.
  vi.stubGlobal('navigator', nav)
  vi.stubGlobal('window', win)
  return {
    goOnline() {
      nav.onLine = true
      for (const cb of listeners.get('online') ?? []) cb()
    },
    restore() {
      vi.unstubAllGlobals()
    },
  }
}

const seed = (adapter: ReturnType<typeof memoryAdapter>, prefix: string, e: Partial<QueueEntry>) => {
  const entry: QueueEntry = {
    v: PROTOCOL_VERSION,
    mutationId: 'x',
    runId: 'r',
    variables: {},
    attempts: 0,
    enqueuedAt: Date.now(),
    ...e,
  }
  adapter.store.set(`${prefix}/${entry.mutationId}/${entry.runId}`, JSON.stringify(entry))
  return entry
}

describe('mutationQueuePlugin — dedupe + cancel contract (T6.2)', () => {
  test('dedupeBy collapses a second enqueue with the same key onto the first', async () => {
    const adapter = memoryAdapter()
    const plugin = mutationQueuePlugin({
      adapter,
      keyPrefix: 'test/mq/dedupe',
      dedupeBy: (_id, vars) => (vars as { key: string }).key,
    })
    plugin.onMutationEnqueue?.({ mutationId: 'm', runId: 'run-1', variables: { key: 'K' }, attempt: 0 })
    plugin.onMutationEnqueue?.({ mutationId: 'm', runId: 'run-2', variables: { key: 'K' }, attempt: 0 })
    await settle()
    // Only the first enqueue wrote a durable entry.
    expect(adapter.store.size).toBe(1)
    plugin.dispose?.()
  })

  test('a cancelled settle keeps the dedupe key active (re-enqueue does NOT double-write)', async () => {
    const adapter = memoryAdapter()
    const plugin = mutationQueuePlugin({
      adapter,
      keyPrefix: 'test/mq/cancel',
      dedupeBy: (_id, vars) => (vars as { key: string }).key,
    })
    plugin.onMutationEnqueue?.({ mutationId: 'm', runId: 'run-1', variables: { key: 'K' }, attempt: 0 })
    await settle()
    expect(adapter.store.size).toBe(1)
    // Reload mid-run looks like a cancel — entry + key must survive.
    plugin.onMutationSettle?.({ mutationId: 'm', runId: 'run-1', outcome: 'cancelled' })
    // Re-enqueue the same logical mutation under a new runId → collapses.
    plugin.onMutationEnqueue?.({ mutationId: 'm', runId: 'run-2', variables: { key: 'K' }, attempt: 0 })
    await settle()
    expect(adapter.store.size).toBe(1) // NOT two entries
    plugin.dispose?.()
  })
})

describe('mutationQueuePlugin — replay reconciliation + manual/online drive (T6.2)', () => {
  test('onReplaySettle fires with the result + an invalidate api after a successful replay', async () => {
    const id = 'mq-test/settle'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/settle', { mutationId: id, runId: 'r1', variables: { a: 1 } })
    defineMutation({ mutationId: id, mutate: async () => 'server-truth' })

    const settled: Array<{ result: unknown; runId: string }> = []
    let invalidatedWith: readonly unknown[] | null = null
    const fakeQuery = { invalidate: (...args: unknown[]) => (invalidatedWith = args) }

    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/settle',
          onReplaySettle: (entry, result, api) => {
            settled.push({ result, runId: entry.runId })
            api.invalidate(fakeQuery as never, ['user', 1])
          },
        }),
      ],
    })
    await settle()
    expect(settled).toEqual([{ result: 'server-truth', runId: 'r1' }])
    expect(invalidatedWith).toEqual(['user', 1])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('replayNow() re-drives a pending entry in-session', async () => {
    const id = 'mq-test/replaynow'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/replaynow', { mutationId: id, runId: 'r1' })
    let calls = 0
    defineMutation({
      mutationId: id,
      mutate: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return 'ok'
      },
    })
    const plugin = mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/replaynow', maxAttempts: 5 })
    const def = defineController(() => ({}))
    const root = createRoot(def, { deps: {}, onError: () => {}, plugins: [plugin] })
    await settle()
    // First replay failed transiently; entry retained for another attempt.
    expect(calls).toBe(1)
    expect(adapter.store.size).toBe(1)
    // Manual re-drive → succeeds, entry dropped.
    await plugin.replayNow()
    await settle()
    expect(calls).toBe(2)
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('replay waits for offline, then fires on the online event', async () => {
    const env = stubOnlineEnv(false)
    try {
      const id = 'mq-test/online'
      _unregisterMutationById(id)
      const adapter = memoryAdapter()
      seed(adapter, 'test/mq/online', { mutationId: id, runId: 'r1' })
      let calls = 0
      defineMutation({ mutationId: id, mutate: async () => (calls += 1) })
      const def = defineController(() => ({}))
      const root = createRoot(def, {
        deps: {},
        plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/online' })],
      })
      await settle()
      expect(calls).toBe(0) // offline → gated
      env.goOnline()
      await settle()
      expect(calls).toBe(1) // reconnect → replayed
      expect(adapter.store.size).toBe(0)
      root.dispose()
    } finally {
      env.restore()
    }
  })
})

describe('mutationQueuePlugin — option surface (T6.2)', () => {
  test('ttlMs drops entries older than the max age and surfaces ttl-expired', async () => {
    const id = 'mq-test/ttl'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/ttl', { mutationId: id, runId: 'r1', enqueuedAt: Date.now() - 60_000 })
    let replayed = 0
    defineMutation({ mutationId: id, mutate: async () => (replayed += 1) })
    const errors: Array<{ code?: string }> = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/ttl',
          ttlMs: 1000,
          onReplayError: (err) => errors.push(err as { code?: string }),
        }),
      ],
    })
    await settle()
    expect(replayed).toBe(0) // expired → never replayed
    expect(adapter.store.size).toBe(0) // dropped
    expect(errors.some((e) => e.code === 'ttl-expired')).toBe(true)
    root.dispose()
  })

  test('migrate upgrades an entry of a prior protocol version', async () => {
    const id = 'mq-test/migrate'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    // A v0 (pre-current) entry the migrator must forward-port.
    adapter.store.set(
      `test/mq/migrate/${id}/r1`,
      JSON.stringify({ v: 0, mutationId: id, runId: 'r1', legacyVars: { n: 7 } }),
    )
    const replayed: unknown[] = []
    defineMutation({ mutationId: id, mutate: async (vars: unknown) => replayed.push(vars) })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/migrate',
          migrate: (raw, from) => {
            const o = raw as { mutationId: string; runId: string; legacyVars: unknown }
            return from === 0
              ? {
                  v: PROTOCOL_VERSION,
                  mutationId: o.mutationId,
                  runId: o.runId,
                  variables: o.legacyVars,
                  attempts: 0,
                  enqueuedAt: Date.now(),
                }
              : null
          },
        }),
      ],
    })
    await settle()
    expect(replayed).toEqual([{ n: 7 }])
    root.dispose()
  })

  test('maxEntryBytes warns when a serialized entry exceeds the soft cap', async () => {
    const adapter = memoryAdapter()
    const warnings: string[] = []
    const plugin = mutationQueuePlugin({
      adapter,
      keyPrefix: 'test/mq/bytes',
      maxEntryBytes: 50,
      onWarn: (m) => warnings.push(m),
    })
    plugin.onMutationEnqueue?.({
      mutationId: 'm',
      runId: 'r1',
      variables: { blob: 'x'.repeat(500) },
      attempt: 0,
    })
    await settle()
    expect(warnings.some((w) => w.includes('soft cap'))).toBe(true)
    // The entry is still written (soft cap — warn, don't block).
    expect(adapter.store.size).toBe(1)
    plugin.dispose?.()
  })

  test('onReplayAttempt fires on a non-final replay failure', async () => {
    const id = 'mq-test/attempt'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/attempt', { mutationId: id, runId: 'r1', attempts: 0 })
    defineMutation({
      mutationId: id,
      mutate: async () => {
        throw new Error('still down')
      },
    })
    const attemptFailures: unknown[] = []
    const finalErrors: unknown[] = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [
        mutationQueuePlugin({
          adapter,
          keyPrefix: 'test/mq/attempt',
          maxAttempts: 5,
          onReplayAttempt: (err) => attemptFailures.push(err),
          onReplayError: (err) => finalErrors.push(err),
        }),
      ],
    })
    await settle()
    // attempts (1) < maxAttempts (5) → non-final: onReplayAttempt, NOT onReplayError.
    expect(attemptFailures).toHaveLength(1)
    expect(finalErrors).toHaveLength(0)
    expect(adapter.store.size).toBe(1) // retained for a future attempt
    root.dispose()
  })

  test('replay ordering uses seq, not enqueuedAt (clock-drift immune)', async () => {
    const id = 'mq-test/seq'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    // enqueuedAt says B-then-A, but seq says A-then-B — seq must win.
    seed(adapter, 'test/mq/seq', {
      mutationId: id,
      runId: 'A',
      variables: 'A',
      seq: 1,
      enqueuedAt: 2000,
    })
    seed(adapter, 'test/mq/seq', {
      mutationId: id,
      runId: 'B',
      variables: 'B',
      seq: 2,
      enqueuedAt: 1000,
    })
    const order: unknown[] = []
    defineMutation({
      mutationId: id,
      mutate: async (vars: unknown) => {
        await flush()
        order.push(vars)
      },
    })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      deps: {},
      plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/seq' })],
    })
    await settle()
    expect(order).toEqual(['A', 'B'])
    root.dispose()
  })

  test('backoffMs delays the replay of an entry with prior attempts', async () => {
    vi.useFakeTimers()
    try {
      const id = 'mq-test/backoff'
      _unregisterMutationById(id)
      const adapter = memoryAdapter()
      seed(adapter, 'test/mq/backoff', { mutationId: id, runId: 'r1', attempts: 1 })
      let calls = 0
      defineMutation({ mutationId: id, mutate: async () => (calls += 1) })
      const def = defineController(() => ({}))
      const root = createRoot(def, {
        deps: {},
        plugins: [mutationQueuePlugin({ adapter, keyPrefix: 'test/mq/backoff', backoffMs: 1000 })],
      })
      await vi.advanceTimersByTimeAsync(0) // reach the backoff sleep
      expect(calls).toBe(0) // still waiting out the backoff window
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(1)
      root.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
