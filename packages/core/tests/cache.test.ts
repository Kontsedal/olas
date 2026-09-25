import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createCache } from '../src'
import { createRoot, defineController } from '../src/controller'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'
import { createTestController } from '../src/testing'

type Deps = Record<string, unknown>
const emptyDeps: Deps = {}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ctx.cache — fetch lifecycle', () => {
  test('loads on construction; data + status update on success', async () => {
    const def = defineController((ctx) => ({
      user: createCache(ctx, async () => ({ id: 'u1', name: 'Alice' })),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.user.isLoading.value).toBe(true)
    expect(root.api.user.status.value).toBe('pending')

    await flush()
    expect(root.api.user.status.value).toBe('success')
    expect(root.api.user.isLoading.value).toBe(false)
    expect(root.api.user.data.value).toEqual({ id: 'u1', name: 'Alice' })
    expect(root.api.user.error.value).toBeUndefined()
    expect(typeof root.api.user.lastUpdatedAt.value).toBe('number')
    root.dispose()
  })

  test('surfaces errors via .error and .status === "error"', async () => {
    const def = defineController((ctx) => ({
      thing: createCache(ctx, async () => {
        throw new Error('boom')
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.thing.status.value).toBe('error')
    expect((root.api.thing.error.value as Error).message).toBe('boom')
    expect(root.api.thing.data.value).toBeUndefined()
    expect(root.api.thing.isLoading.value).toBe(false)
    root.dispose()
  })

  test('refetch() resolves with the new value and updates lastUpdatedAt', async () => {
    let counter = 0
    const def = defineController((ctx) => ({
      counter: createCache(ctx, async () => ++counter),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.counter.data.value).toBe(1)
    const first = root.api.counter.lastUpdatedAt.value!

    await new Promise((r) => setTimeout(r, 5))
    const refetched = await root.api.counter.refetch()
    expect(refetched).toBe(2)
    expect(root.api.counter.data.value).toBe(2)
    expect(root.api.counter.lastUpdatedAt.value).toBeGreaterThan(first)
    root.dispose()
  })

  test('reset() clears error/status but keeps data', async () => {
    let calls = 0
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => {
        calls++
        if (calls === 1) return 'ok'
        throw new Error('boom-on-2')
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    await root.api.x.refetch().catch(() => {})
    expect(root.api.x.status.value).toBe('error')
    expect(root.api.x.data.value).toBe('ok')

    root.api.x.reset()
    expect(root.api.x.status.value).toBe('success')
    expect(root.api.x.error.value).toBeUndefined()
    expect(root.api.x.data.value).toBe('ok')
    root.dispose()
  })

  test('firstValue() resolves on first success', async () => {
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      n: createCache(ctx, () => d.promise),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const promise = root.api.n.firstValue()
    d.resolve(42)
    expect(await promise).toBe(42)
    root.dispose()
  })

  test('firstValue() rejects on first error', async () => {
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      n: createCache(ctx, () => d.promise),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const promise = root.api.n.firstValue()
    d.reject(new Error('nope'))
    await expect(promise).rejects.toThrow('nope')
    root.dispose()
  })
})

describe('ctx.cache — race protection (§5.6)', () => {
  test('latest fetch wins; older results are discarded', async () => {
    const fetchers: Array<{ promise: Promise<string>; resolve: (v: string) => void }> = []
    const def = defineController((ctx) => ({
      thing: createCache(ctx, () => {
        const d = deferred<string>()
        fetchers.push(d)
        return d.promise
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })

    // First fetch from initial load is in flight. Trigger a second.
    const secondPromise = root.api.thing.refetch()
    await flush()

    // Resolve the second (latest) one first
    fetchers[1]!.resolve('second')
    expect(await secondPromise).toBe('second')
    expect(root.api.thing.data.value).toBe('second')

    // Now resolve the first (older) — should be dropped.
    fetchers[0]!.resolve('first')
    await flush()
    expect(root.api.thing.data.value).toBe('second')
    root.dispose()
  })

  test('refetch aborts the previous in-flight fetch via AbortSignal', async () => {
    const seenAborts: boolean[] = []
    const fetchers: Array<{ promise: Promise<string>; resolve: (v: string) => void }> = []
    const def = defineController((ctx) => ({
      thing: createCache(ctx, ({ signal: sig }) => {
        const d = deferred<string>()
        fetchers.push(d)
        sig.addEventListener('abort', () => {
          seenAborts.push(true)
          d.resolve('aborted')
        })
        return d.promise
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    root.api.thing.refetch().catch(() => {})
    await flush()
    expect(seenAborts).toEqual([true])
    root.dispose()
  })
})

describe('ctx.cache — reactive key', () => {
  test('refetches when the key signal changes', async () => {
    const id = signal('a')
    const fetched: string[] = []
    const def = defineController((ctx) => ({
      thing: createCache(
        ctx,
        async () => {
          fetched.push(id.peek())
          return `value-of-${id.peek()}`
        },
        { key: () => [id.value] },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.thing.data.value).toBe('value-of-a')

    id.set('b')
    await flush()
    expect(root.api.thing.data.value).toBe('value-of-b')
    expect(fetched).toEqual(['a', 'b'])
    root.dispose()
  })

  test('with keepPreviousData=false, data is reset on key change', async () => {
    const id = signal('a')
    const d: Record<string, ReturnType<typeof deferred<string>>> = {}
    const def = defineController((ctx) => ({
      thing: createCache(
        ctx,
        () => {
          const cur = id.peek()
          d[cur] = deferred<string>()
          return d[cur]!.promise
        },
        { key: () => [id.value] },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    d.a!.resolve('A')
    await flush()
    expect(root.api.thing.data.value).toBe('A')

    id.set('b')
    await flush()
    // While B is in flight, data is undefined (no keepPreviousData).
    expect(root.api.thing.data.value).toBeUndefined()
    expect(root.api.thing.isLoading.value).toBe(true)

    d.b!.resolve('B')
    await flush()
    expect(root.api.thing.data.value).toBe('B')
    root.dispose()
  })

  test('with keepPreviousData=true, previous data shows until new fetch resolves', async () => {
    const id = signal('a')
    const d: Record<string, ReturnType<typeof deferred<string>>> = {}
    const def = defineController((ctx) => ({
      thing: createCache(
        ctx,
        () => {
          const cur = id.peek()
          d[cur] = deferred<string>()
          return d[cur]!.promise
        },
        { key: () => [id.value], keepPreviousData: true },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    d.a!.resolve('A')
    await flush()
    expect(root.api.thing.data.value).toBe('A')

    id.set('b')
    await flush()
    expect(root.api.thing.data.value).toBe('A') // kept
    expect(root.api.thing.isFetching.value).toBe(true)

    d.b!.resolve('B')
    await flush()
    expect(root.api.thing.data.value).toBe('B')
    root.dispose()
  })
})

describe('ctx.cache — disposal aborts in-flight', () => {
  test('controller dispose aborts the current fetcher signal', async () => {
    let aborted = false
    const def = defineController((ctx) => ({
      thing: createCache(ctx, ({ signal: sig }) => {
        sig.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<string>(() => {
          /* never resolves */
        })
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    root.dispose()
    expect(aborted).toBe(true)
  })
})

describe('ctx.cache — setData and rollback (§6.3, §6.4)', () => {
  test('setData applies optimistic updates and flags hasPendingMutations', async () => {
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => 1),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.x.data.value).toBe(1)
    expect(root.api.x.hasPendingMutations.value).toBe(false)

    const snap = root.api.x.setData((prev) => (prev ?? 0) + 10)
    expect(root.api.x.data.value).toBe(11)
    expect(root.api.x.hasPendingMutations.value).toBe(true)

    snap.rollback()
    expect(root.api.x.data.value).toBe(1)
    expect(root.api.x.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('stacked optimistic updates: later rollback first lands on intermediate state', async () => {
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => 0),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()

    const snapA = root.api.x.setData((p) => (p ?? 0) + 1) // 0 → 1
    const snapB = root.api.x.setData((p) => (p ?? 0) + 10) // 1 → 11
    expect(root.api.x.data.value).toBe(11)

    snapB.rollback() // back to 1 (state after A)
    expect(root.api.x.data.value).toBe(1)
    snapA.rollback() // back to 0
    expect(root.api.x.data.value).toBe(0)
    expect(root.api.x.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('rollback is idempotent', async () => {
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => 'a'),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    const snap = root.api.x.setData(() => 'b')
    snap.rollback()
    snap.rollback() // no-op
    expect(root.api.x.data.value).toBe('a')
    root.dispose()
  })
})

describe('ctx.cache — invalidate / reactive key short-circuit', () => {
  test('invalidate triggers a refetch on the local cache', async () => {
    let calls = 0
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => ++calls, { staleTime: 60_000 }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(calls).toBe(1)

    root.api.x.invalidate()
    await flush()
    expect(calls).toBe(2)
    root.dispose()
  })

  test('re-evaluating the key with the same args does not reset data', async () => {
    // The arraysEqual fast-path inside the key-effect: when the keyFn fires
    // but produces a deep-equal-by-Object.is array, the data must not be
    // cleared.
    const trigger = signal(0)
    let calls = 0
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => ++calls, {
        // The key reads `trigger` to re-run the effect, but the returned
        // tuple never changes — exercising the "arrays equal" branch.
        key: () => {
          trigger.value
          return ['fixed'] as const
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.x.data.value).toBe(1)

    trigger.set(1)
    await flush()
    expect(root.api.x.data.value).toBeDefined()
    root.dispose()
  })
})

describe('ctx.cache via createTestController', () => {
  test('useful in isolation', async () => {
    const userCtl = defineController((ctx, props: { id: string }) => ({
      user: createCache(ctx, async () => ({ id: props.id, name: 'Mocky' })),
    }))
    const root = createTestController(userCtl, {
      deps: emptyDeps,
      props: { id: 'u1' },
    })
    await flush()
    expect(root.api.user.data.value).toEqual({ id: 'u1', name: 'Mocky' })
    root.dispose()
  })
})

describe('ctx.cache — staleTime / isStale', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('isStale is true before any successful fetch, false right after, true after staleTime', async () => {
    vi.setSystemTime(0)
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => 'v', { staleTime: 100 }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    expect(root.api.x.isStale.value).toBe(true)

    // Drain the microtasks that resolve the fetch.
    await vi.advanceTimersByTimeAsync(0)
    expect(root.api.x.data.value).toBe('v')
    expect(root.api.x.isStale.value).toBe(false)

    vi.advanceTimersByTime(50)
    expect(root.api.x.isStale.value).toBe(false)

    vi.advanceTimersByTime(60)
    expect(root.api.x.isStale.value).toBe(true)
    root.dispose()
  })
})

describe('LocalCache.cancel', () => {
  test('aborts the in-flight fetch and keeps the previous data', async () => {
    let n = 0
    let seen: AbortSignal | undefined
    const def = defineController((ctx) => ({
      cache: createCache(ctx, ({ signal }) => {
        n += 1
        if (n === 1) return Promise.resolve('first')
        seen = signal
        return new Promise<string>(() => {}) // never settles on its own
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    await root.api.cache.firstValue()
    void root.api.cache.refetch().catch(() => {})
    expect(root.api.cache.isFetching.value).toBe(true)
    root.api.cache.cancel()
    expect(seen?.aborted).toBe(true)
    expect(root.api.cache.isFetching.value).toBe(false)
    expect(root.api.cache.data.value).toBe('first')
    root.dispose()
  })
})

// The key effect started a fetch on every run, so a thunk that re-ran to an
// equal key refetched and aborted the request in flight, `staleTime` or not.
// `createQuery` compares key hashes; a local cache does too now (§5.4).
describe('ctx.cache — an equal key does nothing', () => {
  test('the reviewer reproduction: a new user object with the same id', async () => {
    const user = signal({ id: 'u1', name: 'Ann' })
    const signals: AbortSignal[] = []
    const def = defineController((ctx) => ({
      profile: createCache(
        ctx,
        async ({ signal: s }) => {
          signals.push(s)
          return `profile of ${user.peek().id}`
        },
        { key: () => [user.value.id], staleTime: 60_000 },
      ),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(signals).toHaveLength(1)

    user.set({ id: 'u1', name: 'Anna' })
    await flush()
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    expect(root.api.profile.data.value).toBe('profile of u1')

    user.set({ id: 'u2', name: 'Bob' })
    await flush()
    expect(signals).toHaveLength(2)
    expect(root.api.profile.data.value).toBe('profile of u2')
    root.dispose()
  })

  test('a structurally equal key built afresh on each run', async () => {
    const filter = signal({ q: 'a', page: 1 })
    let calls = 0
    const def = defineController((ctx) => ({
      results: createCache(ctx, async () => ++calls, {
        key: () => [{ q: filter.value.q, page: filter.value.page }],
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    filter.set({ q: 'a', page: 1 })
    await flush()
    expect(calls).toBe(1)
    filter.set({ q: 'a', page: 2 })
    await flush()
    expect(calls).toBe(2)
    root.dispose()
  })

  test('a key the hash cannot encode still compares by element', async () => {
    class Token {
      constructor(readonly v: string) {}
    }
    const a = new Token('a')
    const tokens = signal<Token[]>([a])
    let calls = 0
    const def = defineController((ctx) => ({
      x: createCache(ctx, async () => ++calls, { key: () => [...tokens.value] }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    tokens.set([a])
    await flush()
    expect(calls).toBe(1)
    tokens.set([new Token('a')])
    await flush()
    expect(calls).toBe(2)
    tokens.set([a, a])
    await flush()
    expect(calls).toBe(3)
    root.dispose()
  })
})
