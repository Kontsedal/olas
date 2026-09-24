import {
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineMutation,
  defineQuery,
  type Mutation,
  type MutationEvent,
  type OlasPlugin,
  type PluginHost,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MutationQueue, mutationQueuePlugin } from '../src/plugin'
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

/**
 * Drive a queue plugin's `onMutation` directly, without a root. The host is a
 * fake: online, with no registered definitions, so the startup replay is a
 * no-op against an empty store. The adapters translate the enqueue/settle
 * vocabulary these tests were written in into `MutationEvent`s.
 */
function directHooks(plugin: OlasPlugin) {
  const host: PluginHost = {
    deps: {},
    provide() {},
    reportError() {},
    onDispose() {},
    track() {},
    network: { isOnline: () => true, onReconnect: () => () => {}, onFocus: () => () => {} },
    queries: {
      get: () => undefined,
      keys: () => [],
      peek: () => undefined,
      write() {},
      replace() {},
      invalidate: async () => {},
      hydrate() {},
      dehydrate: () => ({ version: 1, entries: [] }),
      hashKey: (key) => JSON.stringify(key),
    },
    mutations: { has: () => false, run: () => Promise.reject(new Error('no definitions')) },
    debug() {},
  }
  const hooks = plugin.setup(host) ?? {}
  const emit = (event: Omit<MutationEvent, 'origin'>) =>
    hooks.onMutation?.({ ...event, origin: undefined })
  return {
    enqueue(e: { mutationId: string; runId: string; variables: unknown; attempt?: number }) {
      emit({
        mutation: { id: e.mutationId, meta: { persist: true } },
        runId: e.runId,
        variables: e.variables,
        phase: 'start',
      })
    },
    settle(e: {
      mutationId: string
      runId: string
      outcome: 'success' | 'error' | 'cancelled'
      error?: unknown
      variables?: unknown
    }) {
      emit({
        mutation: { id: e.mutationId, meta: { persist: true } },
        runId: e.runId,
        variables: e.variables,
        phase: e.outcome === 'cancelled' ? 'cancel' : e.outcome,
        ...(e.error !== undefined ? { error: e.error } : {}),
      })
    },
    dispose() {
      hooks.dispose?.()
    },
  }
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
      id: MUTATION_ID,
      mutate: async (vars: { sku: string }) => ({ id: 'srv-1', ...vars }),
      meta: { persist: true },
    })
    const def = defineController((ctx) => ({
      create: createMutation(ctx, createOrder) as Mutation<{ sku: string }, unknown>,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/v1' })],
    })

    expect(adapter.store.size).toBe(0)

    const promise = root.api.create.run({ sku: 'A-1' })
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
      id: id,
      mutate: async (_vars: { x: number }) => {
        calls()
        throw new Error('server 500')
      },
      meta: { persist: true },
    })

    const def = defineController((ctx) => ({
      run: createMutation(ctx, { ...failingMutation, retry: 0 }) as Mutation<
        { x: number },
        unknown
      >,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/err', maxAttempts: 3 }),
      ],
    })

    await root.api.run.run({ x: 1 }).catch(() => {})
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
      id: id,
      mutate: async (vars: { sku: string }) => {
        replayCalls.push(vars)
        return { id: 'srv-9', ...vars }
      },
      meta: { persist: true },
    })

    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/replay' })],
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
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
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
      id: id,
      mutate: async () => 'success',
      meta: { persist: true },
    })

    const errors: Array<{ err: unknown; entry: QueueEntry }> = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
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
      id: idA,
      mutate: async (vars: unknown) => {
        await flush() // give the parallel B run a chance to interleave
        aOrder.push(vars)
      },
      meta: { persist: true },
    })
    defineMutation({
      id: idB,
      mutate: async (vars: unknown) => vars,
      meta: { persist: true },
    })

    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/serial' })],
    })
    // Waits for the startup replay: the plugin tracks it.
    await root.waitForIdle()

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
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
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
    expect(() => mutationQueuePlugin({ storage: adapter, keyPrefix: '' })).toThrow(
      /keyPrefix is required/,
    )
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
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: minimal,
          keyPrefix: 'test/mq/no-keys',
          onWarn: (msg) => warnings.push(msg),
        }),
      ],
    })
    await settle()
    expect(warnings.some((w) => w.includes('keys()'))).toBe(true)
    root.dispose()
  })

  test('defineMutation throws on an empty id', () => {
    expect(() =>
      defineMutation({
        id: '',
        mutate: async () => undefined,
        meta: { persist: true },
      }),
    ).toThrow(/non-empty `id`/)
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
    /** How many `online` listeners the plugin currently holds on `window`. */
    listenerCount(ev: string) {
      return listeners.get(ev)?.size ?? 0
    },
    restore() {
      vi.unstubAllGlobals()
    },
  }
}

const seed = (
  adapter: ReturnType<typeof memoryAdapter>,
  prefix: string,
  e: Partial<QueueEntry>,
) => {
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
      storage: adapter,
      keyPrefix: 'test/mq/dedupe',
      dedupeBy: (_id, vars) => (vars as { key: string }).key,
    })
    const hooks = directHooks(plugin)
    hooks.enqueue({
      mutationId: 'm',
      runId: 'run-1',
      variables: { key: 'K' },
      attempt: 0,
    })
    hooks.enqueue({
      mutationId: 'm',
      runId: 'run-2',
      variables: { key: 'K' },
      attempt: 0,
    })
    await settle()
    // Only the first enqueue wrote a durable entry.
    expect(adapter.store.size).toBe(1)
    hooks.dispose()
  })

  test('a cancelled settle keeps the dedupe key active (re-enqueue does NOT double-write)', async () => {
    const adapter = memoryAdapter()
    const plugin = mutationQueuePlugin({
      storage: adapter,
      keyPrefix: 'test/mq/cancel',
      dedupeBy: (_id, vars) => (vars as { key: string }).key,
    })
    const hooks = directHooks(plugin)
    hooks.enqueue({
      mutationId: 'm',
      runId: 'run-1',
      variables: { key: 'K' },
      attempt: 0,
    })
    await settle()
    expect(adapter.store.size).toBe(1)
    // Reload mid-run looks like a cancel — entry + key must survive.
    hooks.settle({
      mutationId: 'm',
      runId: 'run-1',
      outcome: 'cancelled',
    })
    // Re-enqueue the same logical mutation under a new runId → collapses.
    hooks.enqueue({
      mutationId: 'm',
      runId: 'run-2',
      variables: { key: 'K' },
      attempt: 0,
    })
    await settle()
    expect(adapter.store.size).toBe(1) // NOT two entries
    hooks.dispose()
  })
})

describe('mutationQueuePlugin — replay reconciliation + manual/online drive (T6.2)', () => {
  test('onReplaySettle fires with the result and the root query host after a successful replay', async () => {
    const id = 'mq-test/settle'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/settle', { mutationId: id, runId: 'r1', variables: { a: 1 } })
    let finishReplay!: (value: string) => void
    defineMutation({
      id: id,
      mutate: () =>
        new Promise<string>((resolve) => {
          finishReplay = resolve
        }),
      meta: { persist: true },
    })

    const settled: Array<{ result: unknown; runId: string }> = []
    const calls: string[] = []
    const query = defineQuery({
      id: 'plugin/523',
      key: (id: number) => ['user', id],
      fetcher: async ({ deps }, id: number) => {
        calls.push(`${deps.owner}:${id}`)
        return id
      },
      staleTime: Infinity,
    })

    const def = defineController((ctx) => ({ sub: createQuery(ctx, query, () => [1]) }))
    const other = createRoot(def, { queries: queryEngine(), deps: { owner: 'other' } })
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: { owner: 'queue' },
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
          keyPrefix: 'test/mq/settle',
          onReplaySettle: (entry, result, queries) => {
            settled.push({ result, runId: entry.runId })
            void queries.invalidate('plugin/523', ['user', 1])
          },
        }),
      ],
    })
    // Not `root.waitForIdle()`: it waits for the startup replay, which is
    // parked on `finishReplay` below.
    await other.waitForIdle()
    await vi.waitFor(() => expect(finishReplay).toBeTypeOf('function'))
    // Both roots have fetched once before the replay settles.
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    calls.length = 0
    finishReplay('server-truth')
    await settle()
    expect(settled).toEqual([{ result: 'server-truth', runId: 'r1' }])
    expect(calls).toEqual(['queue:1'])
    expect(adapter.store.size).toBe(0)
    root.dispose()
    other.dispose()
  })

  test('replayNow() re-drives a pending entry in-session', async () => {
    const id = 'mq-test/replaynow'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/replaynow', { mutationId: id, runId: 'r1' })
    let calls = 0
    defineMutation({
      id: id,
      mutate: async () => {
        calls += 1
        if (calls === 1) throw new Error('transient')
        return 'ok'
      },
      meta: { persist: true },
    })
    const plugin = mutationQueuePlugin({
      storage: adapter,
      keyPrefix: 'test/mq/replaynow',
      maxAttempts: 5,
    })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [plugin],
    })
    await settle()
    // First replay failed transiently; entry retained for another attempt.
    expect(calls).toBe(1)
    expect(adapter.store.size).toBe(1)
    // Manual re-drive → succeeds, entry dropped.
    await root.inject(MutationQueue).replayNow()
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
      defineMutation({ id: id, mutate: async () => (calls += 1), meta: { persist: true } })
      const def = defineController(() => ({}))
      const root = createRoot(def, {
        queries: queryEngine(),
        deps: {},
        plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/online' })],
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
    defineMutation({ id: id, mutate: async () => (replayed += 1), meta: { persist: true } })
    const errors: Array<{ code?: string }> = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
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
    defineMutation({
      id: id,
      mutate: async (vars: unknown) => replayed.push(vars),
      meta: { persist: true },
    })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
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
      storage: adapter,
      keyPrefix: 'test/mq/bytes',
      maxEntryBytes: 50,
      onWarn: (m) => warnings.push(m),
    })
    const hooks = directHooks(plugin)
    hooks.enqueue({
      mutationId: 'm',
      runId: 'r1',
      variables: { blob: 'x'.repeat(500) },
      attempt: 0,
    })
    await settle()
    expect(warnings.some((w) => w.includes('soft cap'))).toBe(true)
    // The entry is still written (soft cap — warn, don't block).
    expect(adapter.store.size).toBe(1)
    hooks.dispose()
  })

  test('onReplayAttempt fires on a non-final replay failure', async () => {
    const id = 'mq-test/attempt'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    seed(adapter, 'test/mq/attempt', { mutationId: id, runId: 'r1', attempts: 0 })
    defineMutation({
      id: id,
      mutate: async () => {
        throw new Error('still down')
      },
      meta: { persist: true },
    })
    const attemptFailures: unknown[] = []
    const finalErrors: unknown[] = []
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
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
      id: id,
      mutate: async (vars: unknown) => {
        await flush()
        order.push(vars)
      },
      meta: { persist: true },
    })
    const def = defineController(() => ({}))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/seq' })],
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
      defineMutation({ id: id, mutate: async () => (calls += 1), meta: { persist: true } })
      const def = defineController(() => ({}))
      const root = createRoot(def, {
        queries: queryEngine(),
        deps: {},
        plugins: [
          mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/backoff', backoffMs: 1000 }),
        ],
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

describe('a run that completed before dispose must not be replayed', () => {
  const MUTATION_ID = 'mq-test/completed-then-disposed'

  beforeEach(() => {
    _unregisterMutationById(MUTATION_ID)
  })

  test('settles as success, so the durable entry is dropped rather than left for replay', async () => {
    // `outcome: 'cancelled'` tells this plugin to KEEP the entry and replay it
    // on the next page load. For a run whose request the server already
    // accepted that is a second write of the same mutation — so a completed
    // run reports success even when the abort beat its continuation.
    const adapter = memoryAdapter()
    let resolveWrite: (v: { id: string }) => void = () => {}
    const pending = new Promise<{ id: string }>((res) => {
      resolveWrite = res
    })
    const createOrder = defineMutation({
      id: MUTATION_ID,
      // Not `async`: an async wrapper adds a microtask hop, and the window
      // below is measured in hops.
      mutate: (_vars: { sku: string }) => pending,
      meta: { persist: true },
    })
    const def = defineController((ctx) => ({
      create: createMutation(ctx, createOrder) as Mutation<{ sku: string }, unknown>,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/v1' })],
    })

    const run = root.api.create.run({ sku: 'A-1' }).catch((e: unknown) => e)
    expect(adapter.store.size).toBe(1)

    resolveWrite({ id: 'srv-1' }) // the server accepts the write…
    // …and the screen closes in the window after the work completed but before
    // the run's continuation ran.
    await Promise.resolve()
    await Promise.resolve()
    root.api.create.dispose()

    // Proves the window was hit: the run reports the abort, and the entry is
    // still gone. Without this the assertion below would also pass on the
    // ordinary success path, where the branch under test never runs.
    expect(((await run) as Error).name).toBe('AbortError')
    await settle()
    expect(adapter.store.size).toBe(0)

    root.dispose()
  })
})

describe('mutationQueuePlugin — a manual retry must not leave a second entry', () => {
  const MUTATION_ID = 'mq-test/manual-retry'

  beforeEach(() => {
    _unregisterMutationById(MUTATION_ID)
  })

  test('a retry that succeeds drops the entry the failed run left behind', async () => {
    // The failed run's entry stays on disk for a cross-load replay. The user
    // then retries by hand, which is a NEW runId, so its success only knows
    // about its own entry. Leave the first one and the next page load writes
    // the order a second time.
    const adapter = memoryAdapter()
    let calls = 0
    const createOrder = defineMutation({
      id: MUTATION_ID,
      mutate: async (vars: { sku: string }) => {
        calls += 1
        if (calls === 1) throw new Error('server 500')
        return { id: 'srv-1', ...vars }
      },
      meta: { persist: true },
    })
    const def = defineController((ctx) => ({
      create: createMutation(ctx, { ...createOrder, retry: 0 }) as Mutation<
        { sku: string },
        unknown
      >,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/retry', maxAttempts: 5 }),
      ],
    })

    await root.api.create.run({ sku: 'A-1' }).catch(() => {})
    await settle()
    expect(adapter.store.size).toBe(1) // retained for replay

    await root.api.create.run({ sku: 'A-1' })
    await settle()
    expect(calls).toBe(2)
    // Nothing left to replay: the write the first entry describes is the one
    // the retry just landed.
    expect(adapter.store.size).toBe(0)

    root.dispose()
  })

  test('a different operation under the same mutationId keeps its own entry', async () => {
    // The supersede rule keys on the variables, not the mutationId — two
    // distinct orders that both fail must both stay queued.
    const adapter = memoryAdapter()
    const createOrder = defineMutation({
      id: MUTATION_ID,
      mutate: async (vars: { sku: string }) => {
        if (vars.sku === 'A-1') throw new Error('server 500')
        return { id: 'srv-2', ...vars }
      },
      meta: { persist: true },
    })
    const def = defineController((ctx) => ({
      create: createMutation(ctx, { ...createOrder, retry: 0 }) as Mutation<
        { sku: string },
        unknown
      >,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/retry2', maxAttempts: 5 }),
      ],
    })

    await root.api.create.run({ sku: 'A-1' }).catch(() => {})
    await settle()
    expect(adapter.store.size).toBe(1)

    await root.api.create.run({ sku: 'B-2' })
    await settle()
    // B-2 succeeded and dropped its own entry; A-1 is still pending replay.
    expect(adapter.store.size).toBe(1)
    const [stored] = [...adapter.store.values()]
    expect((JSON.parse(stored as string) as QueueEntry).variables).toEqual({ sku: 'A-1' })

    root.dispose()
  })

  test('a dedupeBy collapse settles the entry it collapsed onto', async () => {
    // The collapsed run writes no entry of its own. Deleting `event.runId` on
    // its success targets a key that was never written and leaves the owner
    // on disk to replay a write the server already took.
    const adapter = memoryAdapter()
    const plugin = mutationQueuePlugin({
      storage: adapter,
      keyPrefix: 'test/mq/alias',
      maxAttempts: 5,
      dedupeBy: (_id, vars) => (vars as { key: string }).key,
    })
    const hooks = directHooks(plugin)
    hooks.enqueue({
      mutationId: 'm',
      runId: 'run-1',
      variables: { key: 'K' },
      attempt: 0,
    })
    await settle()
    hooks.settle({
      mutationId: 'm',
      runId: 'run-1',
      outcome: 'error',
    })
    await settle()
    expect(adapter.store.size).toBe(1) // retained below maxAttempts

    hooks.enqueue({
      mutationId: 'm',
      runId: 'run-2',
      variables: { key: 'K' },
      attempt: 0,
    })
    hooks.settle({
      mutationId: 'm',
      runId: 'run-2',
      outcome: 'success',
    })
    await settle()
    expect(adapter.store.size).toBe(0)

    hooks.dispose()
  })
})

describe('mutationQueuePlugin — replay skips runs executing in this tab', () => {
  const MUTATION_ID = 'mq-test/inflight-replay'

  beforeEach(() => {
    _unregisterMutationById(MUTATION_ID)
  })

  test('replayNow() inside the enqueue→settle window does not re-fire the run', async () => {
    // A network flap fires `online` (or the app calls `replayNow()`) while a
    // run is still awaiting its response. Its entry is already on disk, so an
    // unguarded replay issues the same POST a second time.
    const adapter = memoryAdapter()
    let calls = 0
    let release: (v: { id: string }) => void = () => {}
    const pending = new Promise<{ id: string }>((res) => {
      release = res
    })
    const createOrder = defineMutation({
      id: MUTATION_ID,
      mutate: (_vars: { sku: string }) => {
        calls += 1
        return pending
      },
      meta: { persist: true },
    })
    const plugin = mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/inflight' })
    const def = defineController((ctx) => ({
      create: createMutation(ctx, createOrder) as Mutation<{ sku: string }, unknown>,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [plugin],
    })
    // Let `init`'s own (empty) replay pass finish, or its `replaying` guard
    // would turn the `replayNow()` below into a no-op and the test would
    // pass without exercising anything.
    await settle()

    const run = root.api.create.run({ sku: 'A-1' })
    expect(adapter.store.size).toBe(1)
    expect(calls).toBe(1)

    await root.inject(MutationQueue).replayNow()
    await settle()
    expect(calls).toBe(1) // the live run was skipped, not replayed

    release({ id: 'srv-1' })
    await run
    await settle()
    expect(adapter.store.size).toBe(0)

    root.dispose()
  })
})

describe('mutationQueuePlugin — dispose releases the offline wait', () => {
  test('dispose() drops every online listener, including the parked replay pass', async () => {
    const env = stubOnlineEnv(false)
    try {
      const id = 'mq-test/dispose-offline'
      _unregisterMutationById(id)
      const adapter = memoryAdapter()
      seed(adapter, 'test/mq/dispose-offline', { mutationId: id, runId: 'r1' })
      let calls = 0
      defineMutation({ id: id, mutate: async () => (calls += 1), meta: { persist: true } })
      const def = defineController(() => ({}))
      const root = createRoot(def, {
        queries: queryEngine(),
        deps: {},
        plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'test/mq/dispose-offline' })],
      })
      await settle()
      expect(calls).toBe(0)
      // The reconnect subscription and the parked `waitForOnline` both go
      // through the engine's one shared `online` listener.
      expect(env.listenerCount('online')).toBe(1)

      root.dispose()
      await settle()
      // Both are gone: the pass released the cross-tab replay lock instead of
      // holding it until a network that may never return.
      expect(env.listenerCount('online')).toBe(0)
      expect(calls).toBe(0)
    } finally {
      env.restore()
    }
  })
})
