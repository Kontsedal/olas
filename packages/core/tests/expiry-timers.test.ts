import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { Entry } from '../src/query/entry'
import { signal } from '../src/signals'
import { abortableSleep } from '../src/utils'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('stale timers', () => {
  test('Infinity stays fresh after fetch, initial hydration and streaming hydration', async () => {
    const entry = new Entry({ fetcher: () => async () => 1, staleTime: Infinity })
    const hydrated = new Entry({
      fetcher: () => async () => 2,
      staleTime: Infinity,
      initialData: 2,
      initialUpdatedAt: Date.now(),
    })
    try {
      await entry.startFetch()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(entry.isStale.peek()).toBe(false)
      expect(hydrated.isStale.peek()).toBe(false)
      entry.applyHydration(3, Date.now())
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(entry.isStale.peek()).toBe(false)
      entry.markStale()
      expect(entry.isStale.peek()).toBe(true)
    } finally {
      entry.dispose()
      hydrated.dispose()
    }
  })

  test('infinite queries with Infinity stay fresh until explicitly invalidated', async () => {
    const fetcher = vi.fn(async () => 'page')
    const q = defineInfiniteQuery({
      key: () => [],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: Infinity,
    })
    const root = createRoot(
      defineController((ctx) => ({ sub: ctx.use(q) })),
      { deps: {} },
    )
    try {
      await root.waitForIdle()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(root.sub.isStale.peek()).toBe(false)
      await root.bindQuery(q).invalidate()
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      root.dispose()
    }
  })

  test('finite delays above the platform limit expire at the correct time and dispose cleanly', async () => {
    const delay = 2_147_483_647 + 1_000
    const entry = new Entry({ fetcher: () => async () => 1, staleTime: delay })
    try {
      await entry.startFetch()
      await vi.advanceTimersByTimeAsync(2_147_483_647)
      expect(entry.isStale.peek()).toBe(false)
      await vi.advanceTimersByTimeAsync(999)
      expect(entry.isStale.peek()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(entry.isStale.peek()).toBe(true)
      await entry.startFetch()
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      entry.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  test('finite hydrated entries expire after their remaining lifetime', async () => {
    const entry = new Entry({
      fetcher: () => async () => 1,
      staleTime: 1_000,
      initialData: 1,
      initialUpdatedAt: Date.now() - 800,
    })
    try {
      await vi.advanceTimersByTimeAsync(199)
      expect(entry.isStale.peek()).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(entry.isStale.peek()).toBe(true)
      entry.applyHydration(2, Date.now() - 900)
      await vi.advanceTimersByTimeAsync(100)
      expect(entry.isStale.peek()).toBe(true)
    } finally {
      entry.dispose()
    }
  })
})

describe('gc timers', () => {
  /**
   * One root, one signal-driven key: switching to 'b' releases entry 'a' and
   * starts its gc timer, switching back re-subscribes. A refetch of 'a' on the
   * way back means the entry was collected during the gap. `staleTime:
   * Infinity` keeps staleness out of it — the only thing that can trigger a
   * second 'a' fetch is gc.
   */
  const roundTrip = async (gcTime: number, gap: number) => {
    const calls: string[] = []
    const q = defineQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id: string) => {
        calls.push(id)
        return id
      },
      staleTime: Infinity,
      gcTime,
    })
    const id = signal('a')
    const root = createRoot(
      defineController((ctx) => ({ sub: ctx.use(q, () => [id.value]) })),
      { deps: {} },
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      id.set('b')
      await vi.advanceTimersByTimeAsync(gap)
      id.set('a')
      await vi.advanceTimersByTimeAsync(0)
      return calls
    } finally {
      root.dispose()
    }
  }

  test('gcTime: Infinity keeps a released entry for the life of the root', async () => {
    expect(await roundTrip(Number.POSITIVE_INFINITY, 5)).toEqual(['a', 'b'])
    expect(vi.getTimerCount()).toBe(0)
  })

  test('gcTime past the platform timer limit does not collect early', async () => {
    expect(await roundTrip(2_147_483_647 + 5_000, 5)).toEqual(['a', 'b'])
  })

  test('control: a finite gcTime still collects after it elapses', async () => {
    expect(await roundTrip(1_000, 500)).toEqual(['a', 'b'])
    expect(await roundTrip(1_000, 1_500)).toEqual(['a', 'b', 'a'])
  })

  test('an orphaned prefetch entry respects gcTime: Infinity', async () => {
    const fetcher = vi.fn(async () => 'v')
    const q = defineQuery({ key: () => [], fetcher, staleTime: Infinity, gcTime: Infinity })
    const root = createRoot(
      defineController(() => ({})),
      { deps: {} },
    )
    try {
      const bound = root.bindQuery(q)
      await bound.prefetch()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(bound.peek()).toBe('v')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      root.dispose()
    }
  })

  test('infinite entries honour gcTime: Infinity and collect on a finite one', async () => {
    const calls: string[] = []
    const q = defineInfiniteQuery({
      key: (id: string) => [id],
      fetcher: async (_ctx, id: string) => {
        calls.push(id)
        return id
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: Infinity,
      gcTime: Infinity,
    })
    const id = signal('a')
    const root = createRoot(
      defineController((ctx) => ({ sub: ctx.use(q, () => [id.value]) })),
      { deps: {} },
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      id.set('b')
      await vi.advanceTimersByTimeAsync(60_000)
      id.set('a')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toEqual(['a', 'b'])
    } finally {
      root.dispose()
    }
  })
})

describe('every user-supplied duration is chunked, not clamped', () => {
  const OVERFLOW = 2_147_483_647 + 5_000

  test('refetchInterval above the platform limit polls once, at the right time', async () => {
    const fetcher = vi.fn(async () => 'v')
    const q = defineQuery({ key: () => [], fetcher, staleTime: 0, refetchInterval: OVERFLOW })
    const root = createRoot(
      defineController((ctx) => ({ sub: ctx.use(q) })),
      { deps: {} },
    )
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(fetcher).toHaveBeenCalledTimes(1)
      // A raw setTimeout would have clamped to ~1ms and fired a poll storm here.
      await vi.advanceTimersByTimeAsync(2_147_483_647)
      expect(fetcher).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      root.dispose()
    }
  })

  test('retry backoff above the platform limit waits, and still aborts', async () => {
    const ac = new AbortController()
    const settled: string[] = []
    void abortableSleep(OVERFLOW, ac.signal).then(
      () => settled.push('resolved'),
      () => settled.push('aborted'),
    )
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(settled).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(settled).toEqual(['resolved'])

    // A non-finite backoff parks until the signal fires rather than resolving.
    const ac2 = new AbortController()
    const parked: string[] = []
    void abortableSleep(Number.POSITIVE_INFINITY, ac2.signal).then(
      () => parked.push('resolved'),
      () => parked.push('aborted'),
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(parked).toEqual([])
    ac2.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(parked).toEqual(['aborted'])
  })

  test('suspend({ maxIdle }) above the platform limit does not dispose early', async () => {
    const disposed: string[] = []
    const root = createRoot(
      defineController((ctx) => {
        ctx.onDispose(() => disposed.push('root'))
        return {}
      }),
      { deps: {} },
    )
    root.suspend({ maxIdle: OVERFLOW })
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(disposed).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(disposed).toEqual(['root'])
  })

  test('suspend({ maxIdle: Infinity }) never auto-disposes', async () => {
    const disposed: string[] = []
    const root = createRoot(
      defineController((ctx) => {
        ctx.onDispose(() => disposed.push('root'))
        return {}
      }),
      { deps: {} },
    )
    try {
      root.suspend({ maxIdle: Number.POSITIVE_INFINITY })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(vi.getTimerCount()).toBe(0)
      expect(disposed).toEqual([])
    } finally {
      root.dispose()
    }
  })
})
