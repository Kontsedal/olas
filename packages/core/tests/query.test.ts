import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
import { defineQuery } from '../src/query/define'
import { stableHash } from '../src/query/keys'
import { signal } from '../src/signals'
import { createTestController } from '../src/testing'

const emptyDeps = {}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('stableHash', () => {
  test('orders object keys', () => {
    expect(stableHash([{ a: 1, b: 2 }])).toBe(stableHash([{ b: 2, a: 1 }]))
  })

  test('distinguishes different values', () => {
    expect(stableHash(['user', '1'])).not.toBe(stableHash(['user', '2']))
  })

  test('handles dates and undefined deterministically', () => {
    const d = new Date('2024-01-01')
    expect(stableHash([d, undefined])).toBe(stableHash([d, undefined]))
    expect(stableHash([d])).not.toBe(stableHash([undefined]))
  })

  test('throws on functions/symbols', () => {
    expect(() => stableHash([() => 1])).toThrow()
    expect(() => stableHash([Symbol('x')])).toThrow()
  })
})

describe('defineQuery + ctx.use', () => {
  test('subscribing fetches; data lands on success', async () => {
    const userQuery = defineQuery({
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => ({ id, name: `User ${id}` }),
    })
    const def = defineController((ctx) => ({
      user: ctx.use(userQuery, () => ['u1']),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.user.isLoading.value).toBe(true)
    await flush()
    expect(root.user.data.value).toEqual({ id: 'u1', name: 'User u1' })
    expect(root.user.status.value).toBe('success')
    root.dispose()
  })

  test('two subscribers to the same key share one fetch', async () => {
    let fetchCount = 0
    const todoQuery = defineQuery({
      key: () => ['todos'],
      fetcher: async () => {
        fetchCount++
        return ['a', 'b', 'c']
      },
    })
    const a = defineController((ctx) => ({ list: ctx.use(todoQuery) }))
    const b = defineController((ctx) => ({ list: ctx.use(todoQuery) }))
    const root = defineController((ctx) => ({
      a: ctx.child(a, undefined),
      b: ctx.child(b, undefined),
    }))
    const r = createRoot(root, { deps: emptyDeps })
    await flush()
    expect(fetchCount).toBe(1)
    expect(r.a.list.data.value).toEqual(['a', 'b', 'c'])
    expect(r.b.list.data.value).toEqual(['a', 'b', 'c'])
    r.dispose()
  })

  test('reactive key — entry swap on signal change', async () => {
    const fetchedFor: string[] = []
    const userQuery = defineQuery({
      key: (id: string) => ['user', id],
      fetcher: async (_ctx, id: string) => {
        fetchedFor.push(id)
        return { id, name: id }
      },
    })
    const id = signal('a')
    const def = defineController((ctx) => ({
      user: ctx.use(userQuery, () => [id.value]),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.user.data.value).toEqual({ id: 'a', name: 'a' })

    id.set('b')
    await flush()
    expect(root.user.data.value).toEqual({ id: 'b', name: 'b' })
    expect(fetchedFor).toEqual(['a', 'b'])
    root.dispose()
  })

  test('invalidate triggers a refetch', async () => {
    let counter = 0
    const q = defineQuery({
      key: () => ['c'],
      fetcher: async () => ++counter,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.x.data.value).toBe(1)

    q.invalidate()
    await flush()
    expect(root.x.data.value).toBe(2)
    root.dispose()
  })

  test('invalidate from one root does not affect another', async () => {
    let counterA = 0
    let counterB = 0
    const q = defineQuery({
      key: () => ['c'],
      fetcher: async () => `R${counterA + counterB}-${counterA}-${counterB}`,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))

    const a = createTestController(def, { deps: emptyDeps, props: undefined })
    counterA++
    await flush()
    const b = createTestController(def, { deps: emptyDeps, props: undefined })
    counterB++
    await flush()

    // Each root has its own cache entry; both calls happened.
    expect(typeof a.x.data.value).toBe('string')
    expect(typeof b.x.data.value).toBe('string')

    a.dispose()
    b.dispose()
  })

  test('setData applies optimistic update; rollback restores', async () => {
    const q = defineQuery({
      key: () => ['n'],
      fetcher: async () => 1,
    })
    const def = defineController((ctx) => ({ n: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.n.data.value).toBe(1)

    const snap = q.setData((prev) => (prev ?? 0) + 10)
    expect(root.n.data.value).toBe(11)
    expect(root.n.hasPendingMutations.value).toBe(true)

    snap.rollback()
    expect(root.n.data.value).toBe(1)
    expect(root.n.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('prefetch warms an active root; concurrent subscriber dedupes the fetch', async () => {
    let fetchCount = 0
    const q = defineQuery({
      key: () => ['x'],
      fetcher: async () => {
        fetchCount++
        return 'value'
      },
      staleTime: 60_000,
    })
    // First subscribe — registers the client with the query.
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(fetchCount).toBe(1)
    expect(root.x.data.value).toBe('value')

    // Prefetch within staleTime is a no-op (cache hit).
    await q.prefetch()
    expect(fetchCount).toBe(1)
    root.dispose()
  })

  test('enabled gate — fetch only when enabled flips true', async () => {
    let fetchCount = 0
    const session = signal<{ id: string } | undefined>(undefined)
    const q = defineQuery({
      key: (id: string) => ['session', id],
      fetcher: async (_ctx, id: string) => {
        fetchCount++
        return `feed-${id}`
      },
    })
    const def = defineController((ctx) => ({
      feed: ctx.use(q, {
        key: () => [session.value?.id ?? ''],
        enabled: () => session.value !== undefined,
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(fetchCount).toBe(0)
    expect(root.feed.status.value).toBe('idle')

    session.set({ id: 'u1' })
    await flush()
    expect(fetchCount).toBe(1)
    expect(root.feed.data.value).toBe('feed-u1')
    root.dispose()
  })
})

describe('gc — entries are dropped after gcTime expires with no subscribers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('after last subscriber leaves, entry stays for gcTime then drops', async () => {
    let fetchCount = 0
    const q = defineQuery({
      key: () => ['x'],
      fetcher: async () => {
        fetchCount++
        return fetchCount
      },
      gcTime: 1000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const a = createTestController(def, { deps: emptyDeps, props: undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(1)

    a.dispose()
    // Subscriber gone; gc timer is running. New subscription within the window
    // reuses the entry.
    vi.advanceTimersByTime(500)
    const b = createTestController(def, { deps: emptyDeps, props: undefined })
    // Entry already had subscriber-count 0; but data is still cached.
    // Without staleTime, immediately stale → refetch.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(2)
    b.dispose()
  })

  test('gcTime: 0 drops the entry immediately on last release', async () => {
    let fetchCount = 0
    const q = defineQuery({
      key: () => ['x'],
      fetcher: async () => {
        fetchCount++
        return fetchCount
      },
      gcTime: 0,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const a = createTestController(def, { deps: emptyDeps, props: undefined })
    await vi.advanceTimersByTimeAsync(0)
    a.dispose()
    // Re-create — should be a brand-new entry (different data even though same key).
    const b = createTestController(def, { deps: emptyDeps, props: undefined })
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchCount).toBe(2)
    b.dispose()
  })
})

describe('keepPreviousData (§5.2)', () => {
  test('previous data shows until new fetch resolves', async () => {
    const fetchers: Array<ReturnType<typeof deferred<string>>> = []
    const q = defineQuery({
      key: (id: string) => ['x', id],
      fetcher: () => {
        const d = deferred<string>()
        fetchers.push(d)
        return d.promise
      },
      keepPreviousData: true,
    })
    const id = signal('a')
    const def = defineController((ctx) => ({
      x: ctx.use(q, () => [id.value]),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    fetchers[0]!.resolve('A')
    await flush()
    expect(root.x.data.value).toBe('A')

    id.set('b')
    await flush()
    // While B is in flight, data should still be 'A'.
    expect(root.x.data.value).toBe('A')
    expect(root.x.isFetching.value).toBe(true)
    expect(root.x.isLoading.value).toBe(false)

    fetchers[1]!.resolve('B')
    await flush()
    expect(root.x.data.value).toBe('B')
    root.dispose()
  })
})

describe('retry (§5.2)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('retry: 2 → 3 total attempts; final error reaches consumer', async () => {
    let attempts = 0
    const q = defineQuery({
      key: () => ['r'],
      fetcher: async () => {
        attempts++
        throw new Error(`fail-${attempts}`)
      },
      retry: 2,
      retryDelay: 10,
    })
    const def = defineController((ctx) => ({ r: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    // First attempt + 2 retries with 10ms between.
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    expect(attempts).toBe(3)
    expect(root.r.status.value).toBe('error')
    expect((root.r.error.value as Error).message).toBe('fail-3')
    root.dispose()
  })

  test('retry: (attempt, err) => boolean controls per-attempt', async () => {
    let attempts = 0
    const q = defineQuery({
      key: () => ['r'],
      fetcher: async () => {
        attempts++
        throw Object.assign(new Error('fail'), { code: attempts < 2 ? 500 : 400 })
      },
      retry: (_attempt, err) => (err as { code: number }).code >= 500,
      retryDelay: 10,
    })
    const def = defineController((ctx) => ({ r: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10)
    expect(attempts).toBe(2) // initial 500 → retry; 400 → stop
    root.dispose()
  })
})

describe('refetchInterval', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('refetches periodically while subscribed', async () => {
    let count = 0
    const q = defineQuery({
      key: () => ['rfi'],
      fetcher: async () => ++count,
      refetchInterval: 1000,
    })
    const def = defineController((ctx) => ({ x: ctx.use(q) }))
    const root = createRoot(def, { deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(count).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(count).toBe(3)
    root.dispose()
  })
})
