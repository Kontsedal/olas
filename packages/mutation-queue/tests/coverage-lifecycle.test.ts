import {
  createMutation,
  createRoot,
  defineController,
  defineMutation,
  type Mutation,
  type MutationEvent,
  type OlasPlugin,
  type PluginHost,
  queryEngine,
} from '@kontsedal/olas-core'
import { _unregisterMutationById } from '@kontsedal/olas-core/testing'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MutationQueue, mutationQueuePlugin, PROTOCOL_VERSION, type QueueEntry } from '../src'

// Edge paths of the queue's lifecycle: setup requirements, what `replayAll`
// does with odd storage contents, replay outcomes, live-run bookkeeping and
// the default `onWarn` / `onReplayError` handlers.

type MemoryAdapter = StorageAdapter & {
  store: Map<string, string>
  keys(): string[]
}

function memoryAdapter(): MemoryAdapter {
  const store = new Map<string, string>()
  return {
    store,
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
    keys: () => [...store.keys()],
  }
}

const flush = () => new Promise<void>((r) => queueMicrotask(r))
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush()
}

const entryOf = (e: Partial<QueueEntry> & { mutationId: string; runId: string }): QueueEntry => ({
  v: PROTOCOL_VERSION,
  variables: {},
  attempts: 0,
  enqueuedAt: Date.now(),
  ...e,
})

const seed = (adapter: MemoryAdapter, prefix: string, e: QueueEntry): QueueEntry => {
  adapter.store.set(`${prefix}/${e.mutationId}/${e.runId}`, JSON.stringify(e))
  return e
}

const stored = (adapter: MemoryAdapter): QueueEntry[] =>
  [...adapter.store.values()].map((raw) => JSON.parse(raw) as QueueEntry)

const emptyApp = defineController(() => ({}))

/** A root with the queue plugin and nothing else in it. */
function queueRoot(plugin: OlasPlugin) {
  return createRoot(emptyApp, {
    queries: queryEngine(),
    deps: {},
    onError: () => {},
    plugins: [plugin],
  })
}

/**
 * Drive the plugin's hooks directly through a fake online host with no
 * registered definitions — the same harness `plugin.test.ts` uses. The startup
 * replay runs against whatever the adapter holds.
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
    mutations: {
      has: () => false,
      get: () => undefined,
      run: () => Promise.reject(new Error('no definitions')),
    },
    debug() {},
  }
  const hooks = plugin.setup(host) ?? {}
  const mutation = (id: string) => ({ id, meta: { persist: true } })
  const emit = (event: Omit<MutationEvent, 'origin'>) =>
    hooks.onMutation?.({ ...event, origin: undefined })
  return {
    /** `start`, then the run's first attempt — which is when the queue writes. */
    enqueue(mutationId: string, runId: string, variables: unknown) {
      emit({ mutation: mutation(mutationId), runId, variables, phase: 'start' })
      void hooks.wrapMutate?.(
        {
          mutation: mutation(mutationId),
          runId,
          variables,
          signal: new AbortController().signal,
          attempt: 0,
          origin: undefined,
        },
        () => Promise.resolve(undefined),
      )
    },
    settle(
      mutationId: string,
      runId: string,
      phase: 'success' | 'error' | 'cancel',
      extra: { error?: unknown; variables?: unknown } = {},
    ) {
      emit({ mutation: mutation(mutationId), runId, variables: extra.variables, phase, ...extra })
    },
    dispose() {
      hooks.dispose?.()
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mutationQueuePlugin — setup', () => {
  test('a root without a query engine is rejected with a pointer to queryEngine()', () => {
    const plugin = mutationQueuePlugin({ storage: memoryAdapter(), keyPrefix: 'cov/no-engine' })
    expect(() => createRoot(emptyApp, { deps: {}, plugins: [plugin] })).toThrow(
      /needs a query engine/,
    )
  })
})

describe('mutationQueuePlugin — what replay does with the stored entries', () => {
  test('keys outside `<keyPrefix>/` are neither replayed nor touched, even a sibling prefix', async () => {
    const id = 'cov/foreign-keys'
    _unregisterMutationById(id)
    const replayed: unknown[] = []
    defineMutation({
      id,
      mutate: async (vars: unknown) => {
        replayed.push(vars)
      },
      meta: { persist: true },
    })
    const adapter = memoryAdapter()
    // `app/v10` starts with `app/v1` as a string, but not with `app/v1/`.
    seed(adapter, 'cov/app/v10', entryOf({ mutationId: id, runId: 'r-sibling', variables: 'v10' }))
    seed(adapter, 'other-app', entryOf({ mutationId: id, runId: 'r-other', variables: 'other' }))
    seed(adapter, 'cov/app/v1', entryOf({ mutationId: id, runId: 'r-own', variables: 'own' }))

    const root = queueRoot(mutationQueuePlugin({ storage: adapter, keyPrefix: 'cov/app/v1' }))
    await root.waitForIdle()

    expect(replayed).toEqual(['own'])
    expect([...adapter.store.keys()].sort()).toEqual([
      `cov/app/v10/${id}/r-sibling`,
      `other-app/${id}/r-other`,
    ])
    root.dispose()
  })

  test('a non-object payload, and a key that vanished before it was read, are dropped as malformed', async () => {
    const prefix = 'cov/malformed'
    const adapter = memoryAdapter()
    adapter.store.set(`${prefix}/m/json-null`, 'null')
    adapter.store.set(`${prefix}/m/json-number`, '42')
    const deleted: string[] = []
    const racy: MemoryAdapter = {
      ...adapter,
      // A key another tab deleted between `keys()` and `get()` reads back null.
      keys: () => [...adapter.store.keys(), `${prefix}/m/vanished`],
      delete: (key) => {
        deleted.push(key)
        adapter.store.delete(key)
      },
    }
    const warnings: string[] = []
    const root = queueRoot(
      mutationQueuePlugin({ storage: racy, keyPrefix: prefix, onWarn: (m) => warnings.push(m) }),
    )
    await root.waitForIdle()

    expect(warnings).toEqual([
      `[olas/mutation-queue] dropping malformed entry at ${prefix}/m/json-null`,
      `[olas/mutation-queue] dropping malformed entry at ${prefix}/m/json-number`,
      `[olas/mutation-queue] dropping malformed entry at ${prefix}/m/vanished`,
    ])
    expect(deleted).toEqual([
      `${prefix}/m/json-null`,
      `${prefix}/m/json-number`,
      `${prefix}/m/vanished`,
    ])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('migrate is not consulted for an entry without a numeric version; null and a throw both drop', async () => {
    const prefix = 'cov/migrate'
    const adapter = memoryAdapter()
    adapter.store.set(`${prefix}/m/no-version`, JSON.stringify({ mutationId: 'm', runId: 'a' }))
    adapter.store.set(`${prefix}/m/v0`, JSON.stringify({ v: 0, mutationId: 'm', runId: 'b' }))
    adapter.store.set(`${prefix}/m/v2`, JSON.stringify({ v: 2, mutationId: 'm', runId: 'c' }))
    const migrateCalls: number[] = []
    const boom = new Error('bad migration')
    const warnings: Array<{ message: string; cause: unknown }> = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        migrate: (_raw, from) => {
          migrateCalls.push(from)
          if (from === 2) throw boom
          return null
        },
        onWarn: (message, cause) => warnings.push({ message, cause }),
      }),
    )
    await root.waitForIdle()

    expect(migrateCalls.sort()).toEqual([0, 2])
    expect(warnings).toContainEqual({
      message: '[olas/mutation-queue] migrate threw; dropping entry',
      cause: boom,
    })
    expect(warnings.filter((w) => w.message.includes('dropping malformed entry'))).toHaveLength(3)
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('without migrate, an entry of another protocol version is dropped', async () => {
    const prefix = 'cov/no-migrate'
    const adapter = memoryAdapter()
    adapter.store.set(
      `${prefix}/m/r1`,
      JSON.stringify({ v: 0, mutationId: 'm', runId: 'r1', attempts: 0, enqueuedAt: 1 }),
    )
    const warnings: string[] = []
    const root = queueRoot(
      mutationQueuePlugin({ storage: adapter, keyPrefix: prefix, onWarn: (m) => warnings.push(m) }),
    )
    await root.waitForIdle()

    expect(warnings).toEqual([`[olas/mutation-queue] dropping malformed entry at ${prefix}/m/r1`])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a read that throws is reported, the entry is kept, and the other entries still replay', async () => {
    const id = 'cov/read-throws'
    _unregisterMutationById(id)
    const replayed: unknown[] = []
    defineMutation({
      id,
      mutate: async (vars: unknown) => {
        replayed.push(vars)
      },
      meta: { persist: true },
    })
    const prefix = 'cov/read-throws'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'unreadable', variables: 'x' }))
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'fine', variables: 'y' }))
    const readError = new Error('IDB read failed')
    const flaky: MemoryAdapter = {
      ...adapter,
      get: (key) => {
        if (key.endsWith('/unreadable')) throw readError
        return adapter.get(key)
      },
    }
    const warnings: Array<{ message: string; cause: unknown }> = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: flaky,
        keyPrefix: prefix,
        onWarn: (message, cause) => warnings.push({ message, cause }),
      }),
    )
    await root.waitForIdle()

    expect(warnings).toEqual([
      {
        message: `[olas/mutation-queue] failed to read ${prefix}/${id}/unreadable`,
        cause: readError,
      },
    ])
    expect(replayed).toEqual(['y'])
    expect([...adapter.store.keys()]).toEqual([`${prefix}/${id}/unreadable`])
    root.dispose()
  })

  test('a keys() that rejects fails the pass through onWarn, without throwing', async () => {
    const listError = new Error('keys unavailable')
    const adapter: StorageAdapter & { keys(): Promise<string[]> } = {
      get: () => null,
      set: () => {},
      delete: () => {},
      keys: () => Promise.reject(listError),
    }
    const warnings: Array<{ message: string; cause: unknown }> = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: 'cov/keys-reject',
        onWarn: (message, cause) => warnings.push({ message, cause }),
      }),
    )
    await root.waitForIdle()

    expect(warnings).toEqual([{ message: '[olas/mutation-queue] replay failed', cause: listError }])
    root.dispose()
  })

  test('ttlMs keeps and replays an entry still inside its max age', async () => {
    const id = 'cov/ttl-fresh'
    _unregisterMutationById(id)
    const replayed: unknown[] = []
    defineMutation({
      id,
      mutate: async (vars: unknown) => {
        replayed.push(vars)
      },
      meta: { persist: true },
    })
    const prefix = 'cov/ttl-fresh'
    const adapter = memoryAdapter()
    const now = Date.now()
    seed(
      adapter,
      prefix,
      entryOf({ mutationId: id, runId: 'old', variables: 'old', enqueuedAt: now - 120_000 }),
    )
    seed(
      adapter,
      prefix,
      entryOf({ mutationId: id, runId: 'new', variables: 'new', enqueuedAt: now - 1_000 }),
    )
    const errors: Array<{ code?: string; runId: string }> = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        ttlMs: 60_000,
        onReplayError: (err, entry) =>
          errors.push({ code: (err as { code?: string }).code, runId: entry.runId }),
      }),
    )
    await root.waitForIdle()

    expect(replayed).toEqual(['new'])
    expect(errors).toEqual([{ code: 'ttl-expired', runId: 'old' }])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })
})

describe('mutationQueuePlugin — replay outcomes', () => {
  test('the last allowed replay failing drops the entry and reports the bumped entry', async () => {
    const id = 'cov/final-failure'
    _unregisterMutationById(id)
    const failure = new Error('still 500')
    defineMutation({
      id,
      mutate: async () => {
        throw failure
      },
      meta: { persist: true },
    })
    const prefix = 'cov/final-failure'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'r1', attempts: 2 }))
    const finalErrors: Array<{ err: unknown; entry: QueueEntry }> = []
    const attempts: unknown[] = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        maxAttempts: 3,
        onReplayError: (err, entry) => finalErrors.push({ err, entry }),
        onReplayAttempt: (err) => attempts.push(err),
      }),
    )
    await root.waitForIdle()

    expect(finalErrors).toHaveLength(1)
    expect(finalErrors[0]?.err).toBe(failure)
    expect(finalErrors[0]?.entry).toMatchObject({ mutationId: id, runId: 'r1', attempts: 3 })
    expect(attempts).toEqual([])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a throwing onReplaySettle is routed to onWarn; the entry still drops and the next one replays', async () => {
    const id = 'cov/settle-throws'
    _unregisterMutationById(id)
    defineMutation({ id, mutate: async (vars: unknown) => vars, meta: { persist: true } })
    const prefix = 'cov/settle-throws'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'a', variables: 'A', seq: 1 }))
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'b', variables: 'B', seq: 2 }))
    const reconcileError = new Error('reconciler bug')
    const settled: unknown[] = []
    const warnings: Array<{ message: string; cause: unknown }> = []
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        onReplaySettle: (_entry, result) => {
          settled.push(result)
          throw reconcileError
        },
        onWarn: (message, cause) => warnings.push({ message, cause }),
      }),
    )
    await root.waitForIdle()

    expect(settled).toEqual(['A', 'B'])
    expect(warnings).toEqual([
      { message: '[olas/mutation-queue] onReplaySettle threw', cause: reconcileError },
      { message: '[olas/mutation-queue] onReplaySettle threw', cause: reconcileError },
    ])
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a throwing onReplayAttempt does not stop the rest of the bucket', async () => {
    const id = 'cov/attempt-throws'
    _unregisterMutationById(id)
    const calls: unknown[] = []
    defineMutation({
      id,
      mutate: async (vars: unknown) => {
        calls.push(vars)
        throw new Error('down')
      },
      meta: { persist: true },
    })
    const prefix = 'cov/attempt-throws'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'a', variables: 'A', seq: 1 }))
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'b', variables: 'B', seq: 2 }))
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        onReplayAttempt: () => {
          throw new Error('buggy indicator')
        },
      }),
    )
    await root.waitForIdle()

    expect(calls).toEqual(['A', 'B'])
    // Both retained for the next load, each with its attempt counted.
    expect(stored(adapter).map((e) => [e.runId, e.attempts])).toEqual([
      ['a', 1],
      ['b', 1],
    ])
    root.dispose()
  })

  test('disposing mid-replay stops the bucket; neither entry counts as a failed attempt', async () => {
    const id = 'cov/dispose-mid-bucket'
    _unregisterMutationById(id)
    const calls: unknown[] = []
    defineMutation({
      id,
      // Never settles by itself; the root's dispose cancels it.
      mutate: (vars: unknown) => {
        calls.push(vars)
        return new Promise<never>(() => {})
      },
      meta: { persist: true },
    })
    const prefix = 'cov/dispose-mid-bucket'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'a', variables: 'A', seq: 1 }))
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'b', variables: 'B', seq: 2 }))
    const reported = vi.fn()
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        onReplayError: reported,
        onReplayAttempt: reported,
      }),
    )
    await vi.waitFor(() => expect(calls).toEqual(['A']))

    root.dispose()
    await settle()

    expect(calls).toEqual(['A'])
    expect(reported).not.toHaveBeenCalled()
    // `a` keeps the attempt it had bumped before running; `b` never started.
    expect(stored(adapter).map((e) => [e.runId, e.attempts])).toEqual([
      ['a', 1],
      ['b', 0],
    ])
  })

  test('a replay pass skips the live run but replays another pending entry', async () => {
    const id = 'cov/inflight-other'
    _unregisterMutationById(id)
    const calls: string[] = []
    let seedCalls = 0
    let releaseLive: (v: string) => void = () => {}
    const createOrder = defineMutation({
      id,
      mutate: (vars: { kind: 'seed' | 'live' }) => {
        calls.push(vars.kind)
        if (vars.kind === 'live') {
          return new Promise<string>((resolve) => {
            releaseLive = resolve
          })
        }
        seedCalls += 1
        return seedCalls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve('ok')
      },
      meta: { persist: true },
    })
    const prefix = 'cov/inflight-other'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'seeded', variables: { kind: 'seed' } }))
    const def = defineController((ctx) => ({
      create: createMutation(ctx, createOrder) as Mutation<{ kind: 'seed' | 'live' }, string>,
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: prefix })],
    })
    await root.waitForIdle()
    expect(calls).toEqual(['seed']) // failed once, retained

    const live = root.api.create.run({ kind: 'live' })
    await vi.waitFor(() => expect(calls).toEqual(['seed', 'live']))
    expect(adapter.store.size).toBe(2)

    await root.inject(MutationQueue).replayNow()
    // The seeded entry replayed and dropped; the live one was left to its run.
    expect(calls).toEqual(['seed', 'live', 'seed'])
    expect(stored(adapter).map((e) => (e.variables as { kind: string }).kind)).toEqual(['live'])

    releaseLive('done')
    await expect(live).resolves.toBe('done')
    await settle()
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('a seq from disk ahead of this tab primes the counter, so later enqueues sort after it', async () => {
    const orphanId = 'cov/seq-prime-orphan'
    const liveId = 'cov/seq-prime-live'
    _unregisterMutationById(liveId)
    let release: () => void = () => {}
    const save = defineMutation({
      id: liveId,
      mutate: () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      meta: { persist: true },
    })
    const prefix = 'cov/seq-prime'
    const adapter = memoryAdapter()
    // Written by a tab whose counter ran ahead of this tab's clock.
    const aheadSeq = Date.now() + 10_000_000
    seed(adapter, prefix, entryOf({ mutationId: orphanId, runId: 'old', seq: aheadSeq }))
    const def = defineController((ctx) => ({ save: createMutation(ctx, save) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [
        mutationQueuePlugin({ storage: adapter, keyPrefix: prefix, onReplayError: () => {} }),
      ],
    })
    await root.waitForIdle()

    const run = root.api.save.run(undefined)
    await settle()
    const fresh = stored(adapter).find((e) => e.mutationId === liveId)
    expect(fresh?.seq).toBe(aheadSeq + 1)

    release()
    await run
    root.dispose()
  })
})

describe('mutationQueuePlugin — backoff', () => {
  test('disposing during a backoff wait leaves the entry on disk, unreplayed', async () => {
    vi.useFakeTimers()
    const id = 'cov/backoff-dispose'
    _unregisterMutationById(id)
    let calls = 0
    defineMutation({
      id,
      mutate: async () => {
        calls += 1
      },
      meta: { persist: true },
    })
    const prefix = 'cov/backoff-dispose'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'r1', attempts: 1 }))
    const root = queueRoot(
      mutationQueuePlugin({ storage: adapter, keyPrefix: prefix, backoffMs: 5_000 }),
    )
    await vi.advanceTimersByTimeAsync(1_000) // parked in the backoff sleep

    root.dispose()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(calls).toBe(0)
    expect(stored(adapter)).toEqual([expect.objectContaining({ runId: 'r1', attempts: 1 })])
  })

  test('maxBackoffMs caps the exponential delay', async () => {
    vi.useFakeTimers()
    const id = 'cov/backoff-cap'
    _unregisterMutationById(id)
    let calls = 0
    defineMutation({
      id,
      mutate: async () => {
        calls += 1
      },
      meta: { persist: true },
    })
    const prefix = 'cov/backoff-cap'
    const adapter = memoryAdapter()
    // Uncapped this would be 1000 * 2^9 = 512s.
    seed(adapter, prefix, entryOf({ mutationId: id, runId: 'r1', attempts: 10 }))
    const root = queueRoot(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: prefix,
        maxAttempts: 20,
        backoffMs: 1_000,
        maxBackoffMs: 2_000,
      }),
    )
    await vi.advanceTimersByTimeAsync(1_999)
    expect(calls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(1)
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })
})

describe('mutationQueuePlugin — live runs', () => {
  test('a mutation without persist: true, or without an id, is never written', async () => {
    const id = 'cov/not-persisted'
    _unregisterMutationById(id)
    const adapter = memoryAdapter()
    const set = vi.spyOn(adapter, 'set')
    const plain = defineMutation({ id, mutate: async (n: number) => n * 2 })
    const def = defineController((ctx) => ({
      plain: createMutation(ctx, plain),
      inline: createMutation(ctx, {
        mutate: async (n: number) => n + 1,
        meta: { persist: true },
      }),
    }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'cov/not-persisted' })],
    })

    await expect(root.api.plain.run(2)).resolves.toBe(4)
    await expect(root.api.inline.run(2)).resolves.toBe(3)
    await settle()
    expect(set).not.toHaveBeenCalled()
    root.dispose()
  })

  test('an in-process retry does not write the entry a second time', async () => {
    const id = 'cov/in-process-retry'
    _unregisterMutationById(id)
    let calls = 0
    const save = defineMutation({
      id,
      mutate: async (_v: { n: number }) => {
        calls += 1
        if (calls === 1) throw new Error('flaky')
        return 'ok'
      },
      retry: 1,
      retryDelay: 0,
      meta: { persist: true },
    })
    const adapter = memoryAdapter()
    const set = vi.spyOn(adapter, 'set')
    const def = defineController((ctx) => ({ save: createMutation(ctx, save) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'cov/in-process-retry' })],
    })

    await expect(root.api.save.run({ n: 1 })).resolves.toBe('ok')
    await settle()
    expect(calls).toBe(2)
    expect(set).toHaveBeenCalledTimes(1)
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('runs without variables share an identity, so a successful retry supersedes the failed one', async () => {
    const id = 'cov/no-vars-retry'
    _unregisterMutationById(id)
    let calls = 0
    const ping = defineMutation({
      id,
      mutate: async () => {
        calls += 1
        if (calls === 1) throw new Error('server 500')
        return 'pong'
      },
      meta: { persist: true },
    })
    const adapter = memoryAdapter()
    const def = defineController((ctx) => ({ ping: createMutation(ctx, ping) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [mutationQueuePlugin({ storage: adapter, keyPrefix: 'cov/no-vars-retry' })],
    })

    await root.api.ping.run(undefined).catch(() => {})
    await settle()
    expect(adapter.store.size).toBe(1)

    await expect(root.api.ping.run(undefined)).resolves.toBe('pong')
    await settle()
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('unserializable variables run without a durable entry and supersede nothing', async () => {
    const id = 'cov/unserializable'
    _unregisterMutationById(id)
    let calls = 0
    const save = defineMutation({
      id,
      mutate: async (vars: { n: unknown }) => {
        calls += 1
        if (calls === 1) throw new Error('server 500')
        return typeof vars.n
      },
      meta: { persist: true },
    })
    const prefix = 'cov/unserializable'
    const adapter = memoryAdapter()
    // An unrelated operation of the same mutation, pending replay from a prior load.
    seed(adapter, prefix, entryOf({ mutationId: 'cov/elsewhere', runId: 'kept' }))
    const warnings: string[] = []
    const finalErrors = vi.fn()
    const def = defineController((ctx) => ({ save: createMutation(ctx, save) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
          keyPrefix: prefix,
          onWarn: (m) => warnings.push(m),
          onReplayError: (err, entry) => {
            if (entry.mutationId === id) finalErrors(err)
          },
        }),
      ],
    })
    await root.waitForIdle()

    // BigInt has no JSON form: the write fails, the run still goes out.
    await expect(root.api.save.run({ n: 1n })).rejects.toThrow('server 500')
    await expect(root.api.save.run({ n: 1n })).resolves.toBe('bigint')
    await settle()

    expect(calls).toBe(2)
    expect(warnings.filter((w) => w.includes('failed to persist enqueue'))).toHaveLength(2)
    expect(finalErrors).not.toHaveBeenCalled()
    expect([...adapter.store.keys()]).toEqual([`${prefix}/cov/elsewhere/kept`])
    root.dispose()
  })

  test('maxAttempts: 0 drops a failed run at once and reports the entry it wrote', async () => {
    const id = 'cov/max-zero'
    _unregisterMutationById(id)
    const failure = new Error('rejected')
    const save = defineMutation({
      id,
      mutate: async (_v: { n: number }) => {
        throw failure
      },
      meta: { persist: true },
    })
    const adapter = memoryAdapter()
    const finalErrors: Array<{ err: unknown; entry: QueueEntry }> = []
    const def = defineController((ctx) => ({ save: createMutation(ctx, save) }))
    const root = createRoot(def, {
      queries: queryEngine(),
      deps: {},
      onError: () => {},
      plugins: [
        mutationQueuePlugin({
          storage: adapter,
          keyPrefix: 'cov/max-zero',
          maxAttempts: 0,
          onReplayError: (err, entry) => finalErrors.push({ err, entry }),
        }),
      ],
    })

    await expect(root.api.save.run({ n: 7 })).rejects.toBe(failure)
    await settle()

    expect(finalErrors).toHaveLength(1)
    expect(finalErrors[0]?.err).toBe(failure)
    expect(finalErrors[0]?.entry).toMatchObject({
      mutationId: id,
      variables: { n: 7 },
      attempts: 0,
    })
    expect(adapter.store.size).toBe(0)
    root.dispose()
  })

  test('the delete of a run that settles before its write lands waits for the write — no phantom entry', async () => {
    const memory = memoryAdapter()
    let landWrite: () => void = () => {}
    const slow: MemoryAdapter = {
      ...memory,
      set: (key, value) =>
        new Promise<void>((resolve) => {
          landWrite = () => {
            memory.store.set(key, value)
            resolve()
          }
        }),
    }
    const hooks = directHooks(mutationQueuePlugin({ storage: slow, keyPrefix: 'cov/phantom' }))
    await settle()

    hooks.enqueue('m', 'run-1', { a: 1 })
    hooks.settle('m', 'run-1', 'success')
    await settle()
    landWrite()
    await settle()

    expect(memory.store.size).toBe(0)
    hooks.dispose()
  })

  test('an error settle with no durable record yet reports a synthesized entry at maxAttempts 1', async () => {
    const memory = memoryAdapter()
    let landWrite: () => void = () => {}
    const slow: MemoryAdapter = {
      ...memory,
      set: (key, value) =>
        new Promise<void>((resolve) => {
          landWrite = () => {
            memory.store.set(key, value)
            resolve()
          }
        }),
    }
    const finalErrors: Array<{ err: unknown; entry: QueueEntry }> = []
    const hooks = directHooks(
      mutationQueuePlugin({
        storage: slow,
        keyPrefix: 'cov/synth',
        maxAttempts: 1,
        onReplayError: (err, entry) => finalErrors.push({ err, entry }),
      }),
    )
    await settle()

    hooks.enqueue('m', 'run-1', { a: 1 })
    // The error carries no value, and the write has not landed.
    hooks.settle('m', 'run-1', 'error', { variables: { a: 1 } })
    landWrite()
    await settle()

    expect(finalErrors).toHaveLength(1)
    expect((finalErrors[0]?.err as Error).message).toBe(
      '[olas/mutation-queue] gave up on "m/run-1"',
    )
    expect(finalErrors[0]?.entry).toMatchObject({
      v: PROTOCOL_VERSION,
      mutationId: 'm',
      runId: 'run-1',
      variables: { a: 1 },
      attempts: 1,
    })
    expect(memory.store.size).toBe(0)
    hooks.dispose()
  })

  test('a failing delete is reported through onWarn', async () => {
    const memory = memoryAdapter()
    const dropError = new Error('delete rejected')
    const stuck: MemoryAdapter = { ...memory, delete: () => Promise.reject(dropError) }
    const warnings: Array<{ message: string; cause: unknown }> = []
    const hooks = directHooks(
      mutationQueuePlugin({
        storage: stuck,
        keyPrefix: 'cov/delete-fails',
        onWarn: (message, cause) => warnings.push({ message, cause }),
      }),
    )
    await settle()

    hooks.enqueue('m', 'run-1', {})
    await settle()
    hooks.settle('m', 'run-1', 'success')
    await settle()

    expect(warnings).toEqual([
      { message: '[olas/mutation-queue] failed to drop entry m/run-1', cause: dropError },
    ])
    expect(memory.store.size).toBe(1)
    hooks.dispose()
  })

  test('settling one dedupe key releases only that key', async () => {
    const adapter = memoryAdapter()
    const hooks = directHooks(
      mutationQueuePlugin({
        storage: adapter,
        keyPrefix: 'cov/two-keys',
        dedupeBy: (_id, vars) => (vars as { key: string }).key,
      }),
    )
    await settle()

    hooks.enqueue('m', 'run-a', { key: 'A' })
    hooks.enqueue('m', 'run-b', { key: 'B' })
    await settle()
    hooks.settle('m', 'run-b', 'success')
    await settle()
    // `B` is free again: a new run under it writes its own entry.
    hooks.enqueue('m', 'run-b2', { key: 'B' })
    // `A` is still held by run-a: this collapses onto it.
    hooks.enqueue('m', 'run-a2', { key: 'A' })
    await settle()

    expect(stored(adapter).map((e) => e.runId)).toEqual(['run-a', 'run-b2'])
    hooks.dispose()
  })
})

describe('mutationQueuePlugin — default handlers', () => {
  test('the default onWarn logs the message alone, or the message and its cause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noKeys: StorageAdapter = { get: () => null, set: () => {}, delete: () => {} }
    const first = queueRoot(mutationQueuePlugin({ storage: noKeys, keyPrefix: 'cov/warn-a' }))
    await first.waitForIdle()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toHaveLength(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/no keys\(\) method; replay disabled/)
    first.dispose()

    const listError = new Error('keys unavailable')
    const rejecting = { ...noKeys, keys: () => Promise.reject(listError) }
    const second = queueRoot(mutationQueuePlugin({ storage: rejecting, keyPrefix: 'cov/warn-b' }))
    await second.waitForIdle()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1]).toEqual(['[olas/mutation-queue] replay failed', listError])
    second.dispose()
  })

  test('the default onReplayError logs the entry it gave up on', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const prefix = 'cov/default-error'
    const adapter = memoryAdapter()
    seed(adapter, prefix, entryOf({ mutationId: 'cov/never-defined', runId: 'r9' }))
    const root = queueRoot(mutationQueuePlugin({ storage: adapter, keyPrefix: prefix }))
    await root.waitForIdle()

    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toBe(
      '[olas/mutation-queue] replay failed for cov/never-defined/r9',
    )
    expect((error.mock.calls[0]?.[1] as Error).message).toMatch(/no registered mutation/)
    root.dispose()
  })
})
