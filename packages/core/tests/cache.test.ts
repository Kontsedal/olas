import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRoot, defineController } from '../src/controller'
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
      user: ctx.cache(async () => ({ id: 'u1', name: 'Alice' })),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.user.isLoading.value).toBe(true)
    expect(root.user.status.value).toBe('pending')

    await flush()
    expect(root.user.status.value).toBe('success')
    expect(root.user.isLoading.value).toBe(false)
    expect(root.user.data.value).toEqual({ id: 'u1', name: 'Alice' })
    expect(root.user.error.value).toBeUndefined()
    expect(typeof root.user.lastUpdatedAt.value).toBe('number')
    root.dispose()
  })

  test('surfaces errors via .error and .status === "error"', async () => {
    const def = defineController((ctx) => ({
      thing: ctx.cache(async () => {
        throw new Error('boom')
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.thing.status.value).toBe('error')
    expect((root.thing.error.value as Error).message).toBe('boom')
    expect(root.thing.data.value).toBeUndefined()
    expect(root.thing.isLoading.value).toBe(false)
    root.dispose()
  })

  test('refetch() resolves with the new value and updates lastUpdatedAt', async () => {
    let counter = 0
    const def = defineController((ctx) => ({
      counter: ctx.cache(async () => ++counter),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.counter.data.value).toBe(1)
    const first = root.counter.lastUpdatedAt.value!

    await new Promise((r) => setTimeout(r, 5))
    const refetched = await root.counter.refetch()
    expect(refetched).toBe(2)
    expect(root.counter.data.value).toBe(2)
    expect(root.counter.lastUpdatedAt.value).toBeGreaterThan(first)
    root.dispose()
  })

  test('reset() clears error/status but keeps data', async () => {
    let calls = 0
    const def = defineController((ctx) => ({
      x: ctx.cache(async () => {
        calls++
        if (calls === 1) return 'ok'
        throw new Error('boom-on-2')
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    await root.x.refetch().catch(() => {})
    expect(root.x.status.value).toBe('error')
    expect(root.x.data.value).toBe('ok')

    root.x.reset()
    expect(root.x.status.value).toBe('success')
    expect(root.x.error.value).toBeUndefined()
    expect(root.x.data.value).toBe('ok')
    root.dispose()
  })

  test('firstValue() resolves on first success', async () => {
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      n: ctx.cache(() => d.promise),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const promise = root.n.firstValue()
    d.resolve(42)
    expect(await promise).toBe(42)
    root.dispose()
  })

  test('firstValue() rejects on first error', async () => {
    const d = deferred<number>()
    const def = defineController((ctx) => ({
      n: ctx.cache(() => d.promise),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    const promise = root.n.firstValue()
    d.reject(new Error('nope'))
    await expect(promise).rejects.toThrow('nope')
    root.dispose()
  })
})

describe('ctx.cache — race protection (§5.6)', () => {
  test('latest fetch wins; older results are discarded', async () => {
    const fetchers: Array<{ promise: Promise<string>; resolve: (v: string) => void }> = []
    const def = defineController((ctx) => ({
      thing: ctx.cache(() => {
        const d = deferred<string>()
        fetchers.push(d)
        return d.promise
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })

    // First fetch from initial load is in flight. Trigger a second.
    const secondPromise = root.thing.refetch()
    await flush()

    // Resolve the second (latest) one first
    fetchers[1]!.resolve('second')
    expect(await secondPromise).toBe('second')
    expect(root.thing.data.value).toBe('second')

    // Now resolve the first (older) — should be dropped.
    fetchers[0]!.resolve('first')
    await flush()
    expect(root.thing.data.value).toBe('second')
    root.dispose()
  })

  test('refetch aborts the previous in-flight fetch via AbortSignal', async () => {
    const seenAborts: boolean[] = []
    const fetchers: Array<{ promise: Promise<string>; resolve: (v: string) => void }> = []
    const def = defineController((ctx) => ({
      thing: ctx.cache((sig) => {
        const d = deferred<string>()
        fetchers.push(d)
        sig.addEventListener('abort', () => {
          seenAborts.push(true)
          d.resolve('aborted')
        })
        return d.promise
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    root.thing.refetch().catch(() => {})
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
      thing: ctx.cache(
        async () => {
          fetched.push(id.peek())
          return `value-of-${id.peek()}`
        },
        { key: () => [id.value] },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.thing.data.value).toBe('value-of-a')

    id.set('b')
    await flush()
    expect(root.thing.data.value).toBe('value-of-b')
    expect(fetched).toEqual(['a', 'b'])
    root.dispose()
  })

  test('with keepPreviousData=false, data is reset on key change', async () => {
    const id = signal('a')
    const d: Record<string, ReturnType<typeof deferred<string>>> = {}
    const def = defineController((ctx) => ({
      thing: ctx.cache(
        () => {
          const cur = id.peek()
          d[cur] = deferred<string>()
          return d[cur]!.promise
        },
        { key: () => [id.value] },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    d.a!.resolve('A')
    await flush()
    expect(root.thing.data.value).toBe('A')

    id.set('b')
    await flush()
    // While B is in flight, data is undefined (no keepPreviousData).
    expect(root.thing.data.value).toBeUndefined()
    expect(root.thing.isLoading.value).toBe(true)

    d.b!.resolve('B')
    await flush()
    expect(root.thing.data.value).toBe('B')
    root.dispose()
  })

  test('with keepPreviousData=true, previous data shows until new fetch resolves', async () => {
    const id = signal('a')
    const d: Record<string, ReturnType<typeof deferred<string>>> = {}
    const def = defineController((ctx) => ({
      thing: ctx.cache(
        () => {
          const cur = id.peek()
          d[cur] = deferred<string>()
          return d[cur]!.promise
        },
        { key: () => [id.value], keepPreviousData: true },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    d.a!.resolve('A')
    await flush()
    expect(root.thing.data.value).toBe('A')

    id.set('b')
    await flush()
    expect(root.thing.data.value).toBe('A') // kept
    expect(root.thing.isFetching.value).toBe(true)

    d.b!.resolve('B')
    await flush()
    expect(root.thing.data.value).toBe('B')
    root.dispose()
  })
})

describe('ctx.cache — disposal aborts in-flight', () => {
  test('controller dispose aborts the current fetcher signal', async () => {
    let aborted = false
    const def = defineController((ctx) => ({
      thing: ctx.cache((sig) => {
        sig.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<string>(() => {
          /* never resolves */
        })
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    root.dispose()
    expect(aborted).toBe(true)
  })
})

describe('ctx.cache — setData and rollback (§6.3, §6.4)', () => {
  test('setData applies optimistic updates and flags hasPendingMutations', async () => {
    const def = defineController((ctx) => ({
      x: ctx.cache(async () => 1),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    expect(root.x.data.value).toBe(1)
    expect(root.x.hasPendingMutations.value).toBe(false)

    const snap = root.x.setData((prev) => (prev ?? 0) + 10)
    expect(root.x.data.value).toBe(11)
    expect(root.x.hasPendingMutations.value).toBe(true)

    snap.rollback()
    expect(root.x.data.value).toBe(1)
    expect(root.x.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('stacked optimistic updates: later rollback first lands on intermediate state', async () => {
    const def = defineController((ctx) => ({
      x: ctx.cache(async () => 0),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()

    const snapA = root.x.setData((p) => (p ?? 0) + 1) // 0 → 1
    const snapB = root.x.setData((p) => (p ?? 0) + 10) // 1 → 11
    expect(root.x.data.value).toBe(11)

    snapB.rollback() // back to 1 (state after A)
    expect(root.x.data.value).toBe(1)
    snapA.rollback() // back to 0
    expect(root.x.data.value).toBe(0)
    expect(root.x.hasPendingMutations.value).toBe(false)
    root.dispose()
  })

  test('rollback is idempotent', async () => {
    const def = defineController((ctx) => ({
      x: ctx.cache(async () => 'a'),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    const snap = root.x.setData(() => 'b')
    snap.rollback()
    snap.rollback() // no-op
    expect(root.x.data.value).toBe('a')
    root.dispose()
  })
})

describe('ctx.cache via createTestController', () => {
  test('useful in isolation', async () => {
    const userCtl = defineController((ctx, props: { id: string }) => ({
      user: ctx.cache(async () => ({ id: props.id, name: 'Mocky' })),
    }))
    const root = createTestController(userCtl, {
      deps: emptyDeps,
      props: { id: 'u1' },
    })
    await flush()
    expect(root.user.data.value).toEqual({ id: 'u1', name: 'Mocky' })
    root.dispose()
  })
})

describe('ctx.cache — staleTime / isStale', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('isStale is true before any successful fetch, false right after, true after staleTime', async () => {
    vi.setSystemTime(0)
    const def = defineController((ctx) => ({
      x: ctx.cache(async () => 'v', { staleTime: 100 }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    expect(root.x.isStale.value).toBe(true)

    // Drain the microtasks that resolve the fetch.
    await vi.advanceTimersByTimeAsync(0)
    expect(root.x.data.value).toBe('v')
    expect(root.x.isStale.value).toBe(false)

    vi.advanceTimersByTime(50)
    expect(root.x.isStale.value).toBe(false)

    vi.advanceTimersByTime(60)
    expect(root.x.isStale.value).toBe(true)
    root.dispose()
  })
})
