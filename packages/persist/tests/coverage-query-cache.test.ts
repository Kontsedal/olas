/**
 * `persistQueryCachePlugin` and `restoreQueryCache` failure and filter paths:
 * storage reads and writes that fail, payloads that are not a cache, a root
 * with no query engine, the throttle window coalescing writes, and writes the
 * plugin must not persist.
 */
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { persistQueryCachePlugin, restoreQueryCache, type StorageAdapter } from '../src'

const KEY = 'olas/query-cache'

function memory(): StorageAdapter & { store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    store,
    get: (k) => store.get(k) ?? null,
    set: (k, v) => {
      store.set(k, v)
    },
    delete: (k) => {
      store.delete(k)
    },
  }
}

const persisted = <T>(id: string, fetcher: () => Promise<T>) =>
  defineQuery({ id, key: () => [], fetcher, meta: { persist: true } })

describe('restoreQueryCache — what is not a cache', () => {
  test('a rejected read reports "restore" and resolves undefined', async () => {
    const failure = new Error('IDB closed')
    const onError = vi.fn()
    const storage: StorageAdapter = {
      get: () => Promise.reject(failure),
      set: () => {},
      delete: () => {},
    }
    await expect(restoreQueryCache({ storage, onError })).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(failure, 'restore')
  })

  test('a stored JSON null or a primitive is ignored without an error', async () => {
    const onError = vi.fn()
    const storage = memory()
    storage.store.set(KEY, 'null')
    await expect(restoreQueryCache({ storage, onError })).resolves.toBeUndefined()
    storage.store.set(KEY, '42')
    await expect(restoreQueryCache({ storage, onError })).resolves.toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })

  test('a payload of another format version is dropped whole', async () => {
    const storage = memory()
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 2,
        buster: '',
        entries: [{ id: 'x', key: [], data: 1, lastUpdatedAt: Date.now() }],
      }),
    )
    await expect(restoreQueryCache({ storage })).resolves.toBeUndefined()
  })

  test('malformed entries are dropped and well-formed ones kept', async () => {
    const storage = memory()
    const now = Date.now()
    storage.store.set(
      KEY,
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [
          null,
          'not-an-entry',
          { id: 'no-key', data: 1, lastUpdatedAt: now },
          { id: 'bad-page-params', key: [], data: 1, lastUpdatedAt: now, pageParams: 'p' },
          { id: 'no-timestamp', key: [], data: 1 },
          { id: 'good', key: ['a'], data: 1, lastUpdatedAt: now },
          { id: 'good-infinite', key: [], data: [1], lastUpdatedAt: now, pageParams: [0] },
        ],
      }),
    )
    const hydrate = await restoreQueryCache({ storage })
    expect(hydrate?.entries.map((e) => e.id)).toEqual(['good', 'good-infinite'])
  })

  test('with no onError, a failure is a development warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const storage = memory()
      storage.store.set(KEY, '{corrupt')
      await expect(restoreQueryCache({ storage })).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        '[olas/persist] persistQueryCachePlugin restore failed:',
        expect.any(SyntaxError),
      )
    } finally {
      warn.mockRestore()
    }
  })
})

describe('persistQueryCachePlugin — setup', () => {
  test('a root without a query engine gets a warning and the plugin does nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const storage = memory()
      const get = vi.spyOn(storage, 'get')
      const root = createRoot(
        defineController(() => ({})),
        { deps: {}, plugins: [persistQueryCachePlugin({ storage })] },
      )
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs a query engine'))
      expect(get).not.toHaveBeenCalled()
      root.dispose()
      expect(storage.store.size).toBe(0)
    } finally {
      warn.mockRestore()
    }
  })

  test('an async read that rejects reports "restore" and the root still fetches', async () => {
    const failure = new Error('read failed')
    const onError = vi.fn()
    const storage: StorageAdapter = {
      get: () => Promise.reject(failure),
      set: () => {},
      delete: () => {},
    }
    const q = persisted('cov-qc/async-reject', async () => 'fetched')
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, onError })],
      },
    )
    await root.waitForIdle()
    expect(onError).toHaveBeenCalledWith(failure, 'restore')
    expect(root.api.q.data.value).toBe('fetched')
    root.dispose()
  })
})

describe('persistQueryCachePlugin — writing', () => {
  test('data JSON cannot encode reports "write" and leaves storage untouched', async () => {
    const storage = memory()
    const onError = vi.fn()
    const q = persisted('cov-qc/bigint', async () => ({ big: 10n }))
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, onError, throttleMs: 0 })],
      },
    )
    await root.waitForIdle()
    expect(onError).toHaveBeenCalledWith(expect.any(TypeError), 'write')
    expect(storage.store.has(KEY)).toBe(false)
    root.dispose()
  })

  test('a synchronous storage throw reports "write"', async () => {
    const quota = new Error('QuotaExceededError')
    const onError = vi.fn()
    const storage: StorageAdapter = {
      get: () => null,
      set: () => {
        throw quota
      },
      delete: () => {},
    }
    const q = persisted('cov-qc/sync-throw', async () => 'v')
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, onError, throttleMs: 0 })],
      },
    )
    await root.waitForIdle()
    expect(onError).toHaveBeenCalledWith(quota, 'write')
    expect(root.api.q.data.value).toBe('v')
    root.dispose()
  })

  test('an async write that rejects reports "write", and waitForIdle waits for it', async () => {
    const quota = new Error('QuotaExceededError')
    const onError = vi.fn()
    let rejectWrite: (e: unknown) => void = () => {}
    const storage: StorageAdapter = {
      get: () => null,
      set: () =>
        new Promise<void>((_resolve, reject) => {
          rejectWrite = reject
        }),
      delete: () => {},
    }
    const q = persisted('cov-qc/async-reject-write', async () => 'v')
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, onError, throttleMs: 0 })],
      },
    )
    let idle = false
    const idlePromise = root.waitForIdle().then(() => {
      idle = true
    })
    await vi.waitFor(() => expect(root.api.q.data.value).toBe('v'))
    await Promise.resolve()
    expect(idle).toBe(false) // the tracked write is still in flight
    rejectWrite(quota)
    await idlePromise
    expect(onError).toHaveBeenCalledWith(quota, 'write')
    root.dispose()
  })

  test('a query whose data is undefined is not persisted', async () => {
    const storage = memory()
    const q = persisted('cov-qc/undefined', async () => undefined)
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    await root.waitForIdle()
    expect(root.api.q.status.value).toBe('success')
    expect(storage.store.has(KEY)).toBe(false)
    root.dispose()
  })
})

describe('persistQueryCachePlugin — the throttle window', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('writes inside one window coalesce into a single storage write', async () => {
    const storage = memory()
    const set = vi.spyOn(storage, 'set')
    const a = persisted('cov-qc/a', async () => 'A')
    const b = persisted('cov-qc/b', async () => 'B')
    const root = createRoot(
      defineController((ctx) => ({ a: createQuery(ctx, a), b: createQuery(ctx, b) })),
      { queries: queryEngine(), deps: {}, plugins: [persistQueryCachePlugin({ storage })] },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.a.data.value).toBe('A')
    expect(root.api.b.data.value).toBe('B')
    expect(set).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(set).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(storage.store.get(KEY) as string) as {
      entries: Array<{ id: string; data: unknown }>
    }
    expect(stored.entries.map((e) => [e.id, e.data])).toEqual([
      ['cov-qc/a', 'A'],
      ['cov-qc/b', 'B'],
    ])
    root.dispose()
    // Nothing was pending, so dispose adds no write.
    expect(set).toHaveBeenCalledTimes(1)
  })
})

describe('persistQueryCachePlugin — an async restore that lands after a fetch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('the fetched entry is kept, both in the cache and in what is written next', async () => {
    const store = new Map<string, string>()
    let finishRead: (raw: string) => void = () => {}
    let reads = 0
    const storage: StorageAdapter = {
      // The startup read waits for the test. A flush reads again before it
      // writes, and that read answers at once.
      get: (k) =>
        reads++ > 0
          ? Promise.resolve(store.get(k) ?? null)
          : new Promise<string | null>((resolve) => {
              finishRead = resolve
            }),
      set: (k, v) => {
        store.set(k, v)
      },
      delete: (k) => {
        store.delete(k)
      },
    }
    const q = persisted('cov-qc/raced', async () => 'fresh')
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, plugins: [persistQueryCachePlugin({ storage })] },
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.q.data.value).toBe('fresh') // the fetch won the race

    // Storage answers late, with an older copy of the same entry.
    finishRead(
      JSON.stringify({
        v: 1,
        buster: '',
        entries: [{ id: 'cov-qc/raced', key: [], data: 'stale', lastUpdatedAt: Date.now() - 1 }],
      }),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.q.data.value).toBe('fresh') // not hydrated over the bound entry

    root.dispose() // flushes the pending write, after one more read
    await vi.advanceTimersByTimeAsync(0)
    const written = JSON.parse(store.get(KEY) as string) as {
      entries: Array<{ id: string; data: unknown }>
    }
    expect(written.entries.map((e) => [e.id, e.data])).toEqual([['cov-qc/raced', 'fresh']])
  })
})

describe('persistQueryCachePlugin — gc of a query it never stored', () => {
  test('does not touch storage', async () => {
    const storage = memory()
    const set = vi.spyOn(storage, 'set')
    const q = defineQuery({
      id: 'cov-qc/not-persisted',
      key: () => [],
      fetcher: async () => 'x',
      gcTime: 0,
    })
    const root = createRoot(
      defineController((ctx) => ({
        open: () =>
          ctx.attach(
            defineController((c) => ({ q: createQuery(c, q) })),
            undefined,
          ),
      })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [persistQueryCachePlugin({ storage, throttleMs: 0 })],
      },
    )
    const child = root.api.open()
    await root.waitForIdle()
    expect(child.api.q.data.value).toBe('x')
    child.dispose() // gcTime 0: removed at once
    expect(root.dehydrate().entries.map((e) => e.id)).not.toContain('cov-qc/not-persisted')
    expect(set).not.toHaveBeenCalled()
    root.dispose()
  })
})
