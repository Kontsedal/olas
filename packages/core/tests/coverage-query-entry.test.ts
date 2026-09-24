/**
 * `query/entry.ts` and `query/local.ts` paths the main suites leave dark: the
 * local cache's constant `isEnabled`, its keyed failure and key-length reset,
 * its inert surface after dispose, and `Entry`'s retry-delay function, reset
 * to idle, single-use finalize, rejected `firstValue`, forced staleness, the
 * retry loop's supersede check, and a subscription whose entry was collected
 * while it was suspended.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createCache,
  createQuery,
  createRoot,
  type DebugEvent,
  defineController,
  defineQuery,
  isAbortError,
  queryEngine,
  signal,
} from '../src'
import { createLocalCache } from '../src/query/local'

const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const r of roots.splice(0)) r.dispose()
  vi.useRealTimers()
})
const keep = <T extends { dispose(): void }>(r: T): T => {
  roots.push(r)
  return r
}
const flush = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe('local cache', () => {
  test('isEnabled is a constant true signal, and isPaused reads the entry', async () => {
    const root = keep(
      createRoot(
        defineController((ctx) => ({ c: createCache(ctx, async () => 1) })),
        { deps: {} },
      ),
    )
    const { isEnabled, isPaused } = root.api.c
    expect(isEnabled.value).toBe(true)
    expect(isEnabled.peek()).toBe(true)
    const seen: boolean[] = []
    const unsub = isEnabled.subscribe((v) => seen.push(v))
    expect(seen).toEqual([true]) // the synchronous current-value call
    const changes: boolean[] = []
    const unsubChanges = isEnabled.subscribeChanges((v) => changes.push(v))
    unsub()
    unsubChanges()
    await root.api.c.firstValue()
    expect(changes).toEqual([]) // it never changes
    expect(isPaused.value).toBe(false)
  })

  test('a keyed cache captures a failing fetch as its error', async () => {
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const id = signal(1)
          return {
            id,
            c: createCache(
              ctx,
              async (): Promise<number> => {
                throw new Error('no report')
              },
              { key: () => [id.value] },
            ),
          }
        }),
        { deps: {} },
      ),
    )
    await flush()
    expect(root.api.c.status.value).toBe('error')
    expect((root.api.c.error.value as Error).message).toBe('no report')
  })

  test('switching to a key of a different length resets data while the new key loads', async () => {
    const later: Array<(v: string) => void> = []
    let calls = 0
    const root = keep(
      createRoot(
        defineController((ctx) => {
          const ids = signal<number[]>([1])
          return {
            ids,
            c: createCache(
              ctx,
              () => {
                calls += 1
                if (calls === 1) return Promise.resolve('first')
                return new Promise<string>((res) => later.push(res))
              },
              { key: () => ids.value },
            ),
          }
        }),
        { deps: {} },
      ),
    )
    await flush()
    expect(root.api.c.data.value).toBe('first')
    root.api.ids.set([1, 2])
    expect(root.api.c.data.value).toBeUndefined()
    expect(root.api.c.isLoading.value).toBe(true)
    later[0]?.('second')
    await flush()
    expect(root.api.c.data.value).toBe('second')
  })

  test('invalidate resolves even when the refetch it starts fails', async () => {
    let calls = 0
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          c: createCache(ctx, async () => {
            calls += 1
            if (calls > 1) throw new Error('refetch failed')
            return 'v'
          }),
        })),
        { deps: {} },
      ),
    )
    await root.api.c.firstValue()
    await expect(root.api.c.invalidate()).resolves.toBeUndefined()
    expect(root.api.c.status.value).toBe('error')
    expect(root.api.c.data.value).toBe('v')
  })

  test('after its controller is disposed the cache is inert', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        c: createCache(ctx, async (): Promise<string> => {
          throw new Error('down')
        }),
      })),
      { deps: {} },
    )
    const cache = root.api.c
    await flush()
    expect(cache.status.value).toBe('error')
    root.dispose()

    expect(() => cache.dispose()).not.toThrow() // idempotent
    await expect(cache.refetch()).rejects.toThrow('Entry disposed')
    cache.reset()
    expect(cache.status.value).toBe('error') // reset is a no-op now
    const snap = cache.setData(() => 'written')
    expect(cache.data.value).toBeUndefined()
    expect(() => {
      snap.rollback()
      snap.finalize()
    }).not.toThrow()
    const err = await cache.firstValue().catch((e: unknown) => e)
    expect(isAbortError(err)).toBe(true)
  })

  test('createLocalCache defaults its options and deps', async () => {
    // Internal import: the public `createCache` always passes both.
    const cache = createLocalCache(async ({ deps }) => Object.keys(deps).length)
    expect(await cache.firstValue()).toBe(0)
    expect(cache.isStale.value).toBe(true) // staleTime defaults to 0
    cache.dispose()
  })
})

describe('Entry', () => {
  test('retryDelay as a function sets each backoff', async () => {
    vi.useFakeTimers()
    let calls = 0
    const q = defineQuery({
      id: 'cov-entry/retry-delay-fn',
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        if (calls < 3) throw new Error('flaky')
        return 'ok'
      },
      retry: 2,
      retryDelay: (attempt) => (attempt + 1) * 100,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(99)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2) // after 100ms
    await vi.advanceTimersByTimeAsync(199)
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(3) // after a further 200ms
    expect(root.api.s.data.value).toBe('ok')
  })

  test('reset returns a failed entry with no data to idle', async () => {
    const q = defineQuery({
      id: 'cov-entry/reset-idle',
      key: () => ['k'],
      fetcher: async (): Promise<number> => {
        throw new Error('down')
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await root.waitForIdle()
    expect(root.api.s.status.value).toBe('error')
    root.api.s.reset()
    expect(root.api.s.status.value).toBe('idle')
    expect(root.api.s.error.value).toBeUndefined()
  })

  test('firstValue on a failed entry rejects with its error', async () => {
    const q = defineQuery({
      id: 'cov-entry/first-value-error',
      key: () => ['k'],
      fetcher: async (): Promise<number> => {
        throw new Error('down')
      },
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({
          s: createQuery(ctx, q),
          c: createCache(ctx, async (): Promise<number> => {
            throw new Error('local down')
          }),
        })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    await expect(root.api.s.firstValue()).rejects.toThrow('down')
    await expect(root.api.c.firstValue()).rejects.toThrow('local down')
  })

  test('finalize is single-use, and pending stays true while another layer is live', async () => {
    const q = defineQuery({ id: 'cov-entry/finalize', key: () => ['k'], fetcher: async () => 0 })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q), h: bindQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await root.waitForIdle()
    const events: DebugEvent[] = []
    root.debug.subscribe((e) => events.push(e))
    const finalized = () => events.filter((e) => e.type === 'snapshot:finalize').length

    const a = root.api.h.setData((n) => (n ?? 0) + 1)
    const b = root.api.h.setData((n) => (n ?? 0) + 10)
    expect(root.api.s.hasPendingMutations.value).toBe(true)
    a.finalize()
    expect(root.api.s.hasPendingMutations.value).toBe(true) // b is still live
    a.finalize()
    a.rollback() // a is settled; neither call does anything
    expect(finalized()).toBe(1)
    expect(root.api.s.data.value).toBe(11)
    b.finalize()
    expect(root.api.s.hasPendingMutations.value).toBe(false)
    expect(finalized()).toBe(2)
  })

  test('prefetch after invalidating a subscriber-less entry refetches despite staleTime', async () => {
    const fetcher = vi.fn(async () => 'v')
    const q = defineQuery({
      id: 'cov-entry/forced-stale',
      key: () => ['k'],
      fetcher,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController(() => ({})),
        { queries: queryEngine(), deps: {} },
      ),
    )
    const h = root.bindQuery(q)
    await h.prefetch()
    await h.prefetch()
    expect(fetcher).toHaveBeenCalledTimes(1) // fresh
    await h.invalidate() // no subscriber: marked stale, not refetched
    expect(fetcher).toHaveBeenCalledTimes(1)
    await h.prefetch()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  test('a cancel landing as the retry backoff expires stops the next attempt', async () => {
    vi.useFakeTimers()
    let calls = 0
    const q = defineQuery({
      id: 'cov-entry/cancel-at-backoff',
      key: () => ['k'],
      fetcher: async (): Promise<number> => {
        calls += 1
        throw new Error('flaky')
      },
      retry: 1,
      retryDelay: 10,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q), h: bindQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1) // attempt 0 failed; the backoff ends at t=10
    setTimeout(() => root.api.h.cancel(), 11)
    // One synchronous advance fires the backoff (t=10) and the cancel (t=11)
    // before the retry loop's continuation gets a microtask.
    vi.advanceTimersByTime(20)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(root.api.s.status.value).toBe('idle')
    expect(root.api.s.isFetching.value).toBe(false)
  })

  test('a suspended subscription whose entry was collected fails fast until resumed', async () => {
    const fetcher = vi.fn(async () => 'v')
    const q = defineQuery({ id: 'cov-entry/suspended-gc', key: () => ['k'], fetcher, gcTime: 0 })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        {
          queries: queryEngine(),
          deps: {},
        },
      ),
    )
    await root.waitForIdle()
    root.suspend() // releases the entry; gcTime 0 collects it at once
    expect(root.debug.queryEntries()).toEqual([])
    const sub = root.api.s
    expect(sub.data.value).toBe('v') // the last committed value still reads

    await expect(sub.refetch()).rejects.toThrow()
    sub.reset()
    expect(sub.status.value).toBe('success')
    expect(isAbortError(await sub.firstValue().catch((e: unknown) => e))).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)

    root.resume() // rebinds a fresh entry and fetches
    expect(await sub.firstValue()).toBe('v')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
