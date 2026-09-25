// @vitest-environment jsdom
/**
 * `Entry<T>` at the edges of its state machine (`query/entry.ts`, spec §5.5,
 * §5.6, §5.7, §6.4): the resting state of a fresh or seeded entry; staleness
 * derived from a payload's age on both sides of the `staleTime` boundary; a
 * stale window that restarts on every refetch, hydration and invalidate;
 * which network modes surface a `TypeError` and which park on it; a fetch
 * that aborts itself staying out of the retry policy; structural sharing
 * switched off; the stamp a write leaves on `lastUpdatedAt`; and what a
 * disposed entry leaves alone, and which waiting `firstValue` callers it
 * still rejects.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  isAbortError,
  queryEngine,
} from '../src'
import { Entry } from '../src/query/entry'
import { __resetFocusOnlineForTests } from '../src/query/focus-online'
import { type Controllable, controllable, flushMicrotasks, track } from './property/helpers'

const owned: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const o of owned.splice(0)) o.dispose()
  __resetFocusOnlineForTests()
  vi.unstubAllGlobals()
  setOnline(true)
  vi.useRealTimers()
})
const keep = <T extends { dispose(): void }>(o: T): T => {
  owned.push(o)
  return o
}

function setOnline(v: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })
}

/** A fetch whose every call hands the test a promise to settle by hand. */
function gated<T>(): { gates: Array<Controllable<T>>; fetch: () => Promise<T> } {
  const gates: Array<Controllable<T>> = []
  return {
    gates,
    fetch: () => {
      const c = controllable<T>()
      gates.push(c)
      return c.promise
    },
  }
}

describe('a fresh entry', () => {
  test('starts neither paused, loading nor fetching, with or without seeded data', () => {
    const empty = keep(new Entry<number>({ fetcher: () => async () => 1 }))
    const seeded = keep(
      new Entry<number>({
        fetcher: () => async () => 1,
        initialData: 1,
        initialUpdatedAt: Date.now(),
      }),
    )
    for (const entry of [empty, seeded]) {
      expect(entry.isPaused.peek()).toBe(false)
      expect(entry.isLoading.peek()).toBe(false)
      expect(entry.isFetching.peek()).toBe(false)
    }
  })

  test('reads stale for the refetch check until a fetch succeeds, even after a failure', async () => {
    let calls = 0
    const entry = keep(
      new Entry<number>({
        fetcher: () => async () => {
          calls += 1
          if (calls === 1) throw new Error('down')
          return 1
        },
        staleTime: 60_000,
      }),
    )
    expect(entry.isStaleNow()).toBe(true)
    await entry.startFetch().catch(() => {})
    expect(entry.status.peek()).toBe('error')
    expect(entry.isStaleNow()).toBe(true)
    await entry.startFetch()
    expect(entry.isStaleNow()).toBe(false)
  })

  test('a window focus refetches a query whose first fetch failed', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'mutants-entry/focus-after-failure',
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        if (calls === 1) throw new Error('down')
        return 'recovered'
      },
      refetchOnWindowFocus: true,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q) })),
        { queries: queryEngine(), deps: {}, onError: () => {} },
      ),
    )
    await root.waitForIdle()
    expect(root.api.s.status.value).toBe('error')
    window.dispatchEvent(new Event('focus'))
    await flushMicrotasks()
    await root.waitForIdle()
    expect(calls).toBe(2)
    expect(root.api.s.data.value).toBe('recovered')
  })

  test('fetches when there is no navigator to ask about connectivity', async () => {
    vi.stubGlobal('navigator', undefined)
    const entry = keep(new Entry<number>({ fetcher: () => async () => 7 }))
    await expect(entry.startFetch()).resolves.toBe(7)
    expect(entry.status.peek()).toBe('success')
  })
})

describe('staleness of seeded data', () => {
  test('with staleTime 0 it is stale, even when its stamp is ahead of the local clock', () => {
    const now = keep(
      new Entry<number>({
        fetcher: () => async () => 1,
        initialData: 1,
        initialUpdatedAt: Date.now(),
      }),
    )
    const ahead = keep(
      new Entry<number>({
        fetcher: () => async () => 1,
        initialData: 1,
        initialUpdatedAt: Date.now() + 60_000,
      }),
    )
    expect(now.isStale.peek()).toBe(true)
    expect(ahead.isStale.peek()).toBe(true)
  })

  test('with a finite staleTime and no stamp it is stale', () => {
    const entry = keep(
      new Entry<number>({ fetcher: () => async () => 1, initialData: 1, staleTime: 1_000 }),
    )
    expect(entry.isStale.peek()).toBe(true)
  })

  test('exactly staleTime old it is already stale; a millisecond younger it is fresh', () => {
    vi.useFakeTimers()
    const seed = (age: number) =>
      keep(
        new Entry<number>({
          fetcher: () => async () => 1,
          initialData: 1,
          initialUpdatedAt: Date.now() - age,
          staleTime: 1_000,
        }),
      )
    expect(seed(1_000).isStale.peek()).toBe(true)
    expect(seed(999).isStale.peek()).toBe(false)
  })
})

describe('the stale window restarts', () => {
  test('on a refetch: the earlier window no longer expires the data', async () => {
    vi.useFakeTimers()
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    await entry.startFetch()
    await vi.advanceTimersByTimeAsync(500)
    await entry.refetch()
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(500) // the first window would end here
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(entry.isStale.peek()).toBe(true)
  })

  test('on hydration: the window runs from the hydrated stamp', async () => {
    vi.useFakeTimers()
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    await entry.startFetch()
    await vi.advanceTimersByTimeAsync(500)
    entry.applyHydration(2, Date.now())
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(500) // the fetch's window would end here
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(entry.isStale.peek()).toBe(true)
  })

  test('on invalidate: the refetch it starts gets a full window', async () => {
    vi.useFakeTimers()
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    await entry.startFetch()
    await vi.advanceTimersByTimeAsync(400)
    await entry.invalidate()
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(600) // the first window would end here
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(400)
    expect(entry.isStale.peek()).toBe(true)
  })
})

describe('hydration', () => {
  test('with staleTime 0 it is stale, even with a stamp ahead of the local clock', () => {
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1 }))
    entry.applyHydration(1, Date.now())
    expect(entry.isStale.peek()).toBe(true)
    entry.applyHydration(2, Date.now() + 60_000)
    expect(entry.isStale.peek()).toBe(true)
  })

  test('a payload at or past staleTime reads stale at once', () => {
    vi.useFakeTimers()
    // Each on a fresh entry: a payload older than the data an entry holds is
    // skipped, so it can no longer turn fetched data stale.
    const old = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    old.applyHydration(2, Date.now() - 5_000)
    expect(old.isStale.peek()).toBe(true)

    const edge = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    edge.applyHydration(3, Date.now() - 1_000) // exactly staleTime old
    expect(edge.isStale.peek()).toBe(true)

    const inside = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    inside.applyHydration(4, Date.now() - 999)
    expect(inside.isStale.peek()).toBe(false)
  })

  test('a payload older than the fetched data is skipped', async () => {
    vi.useFakeTimers()
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    await entry.startFetch()
    expect(entry.applyHydration(2, Date.now() - 5_000)).toBe(false)
    expect(entry.data.peek()).toBe(1)
    expect(entry.isStale.peek()).toBe(false)
    expect(entry.applyHydration(3, Date.now())).toBe(true)
    expect(entry.data.peek()).toBe(3)
  })

  test('a fresh payload reads fresh for exactly its remaining lifetime', async () => {
    vi.useFakeTimers()
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 1_000 }))
    expect(entry.isStale.peek()).toBe(true) // never fetched
    entry.applyHydration(1, Date.now() - 300)
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(699)
    expect(entry.isStale.peek()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(entry.isStale.peek()).toBe(true)
  })

  test('stamps lastUpdatedAt with the server time it carries', () => {
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1, staleTime: 60_000 }))
    const serverTime = Date.now() - 10_000
    entry.applyHydration(1, serverTime)
    expect(entry.lastUpdatedAt.peek()).toBe(serverTime)
    expect(entry.isStaleNow()).toBe(false)
  })
})

describe('a TypeError from the fetcher', () => {
  const typeErrorFetcher = () => async (): Promise<number> => {
    throw new TypeError('Failed to fetch')
  }

  test('online mode, online: surfaces as an error', async () => {
    const entry = keep(new Entry<number>({ fetcher: typeErrorFetcher }))
    const outcome = entry.startFetch().catch((e: unknown) => e)
    await flushMicrotasks()
    expect(entry.status.peek()).toBe('error')
    expect(entry.isPaused.peek()).toBe(false)
    expect(await outcome).toBeInstanceOf(TypeError)
  })

  test('offlineFirst, online: surfaces as an error', async () => {
    const entry = keep(
      new Entry<number>({ fetcher: typeErrorFetcher, networkMode: 'offlineFirst' }),
    )
    const outcome = entry.startFetch().catch((e: unknown) => e)
    await flushMicrotasks()
    expect(entry.status.peek()).toBe('error')
    expect(entry.isPaused.peek()).toBe(false)
    expect(await outcome).toBeInstanceOf(TypeError)
  })

  test('always mode, offline: surfaces as an error', async () => {
    setOnline(false)
    const entry = keep(new Entry<number>({ fetcher: typeErrorFetcher, networkMode: 'always' }))
    const outcome = entry.startFetch().catch((e: unknown) => e)
    await flushMicrotasks()
    expect(entry.status.peek()).toBe('error')
    expect(entry.isPaused.peek()).toBe(false)
    expect(await outcome).toBeInstanceOf(TypeError)
  })

  test('offlineFirst, offline, no data: parks idle, neither loading nor fetching', async () => {
    setOnline(false)
    const entry = keep(
      new Entry<number>({ fetcher: typeErrorFetcher, networkMode: 'offlineFirst' }),
    )
    entry.startFetch().catch(() => {}) // parked until reconnect; dispose rejects it
    expect(entry.isLoading.peek()).toBe(true)
    await flushMicrotasks()
    expect(entry.isPaused.peek()).toBe(true)
    expect(entry.status.peek()).toBe('idle')
    expect(entry.isLoading.peek()).toBe(false)
    expect(entry.isFetching.peek()).toBe(false)
    expect(entry.error.peek()).toBeUndefined()
  })
})

describe('the retry policy', () => {
  test('does not retry a fetch that aborted itself', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async (): Promise<number> => {
      throw new DOMException('timed out', 'AbortError')
    })
    const entry = keep(new Entry<number>({ fetcher: () => fetcher, retry: 3, retryDelay: 10 }))
    const outcome = entry.startFetch().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(entry.status.peek()).toBe('error')
    expect(entry.isFetching.peek()).toBe(false)
    expect(isAbortError(await outcome)).toBe(true)
  })

  test('a fetch superseded as its backoff ends rejects with an AbortError', async () => {
    vi.useFakeTimers()
    let calls = 0
    const entry = keep(
      new Entry<number>({
        fetcher: () => async () => {
          calls += 1
          throw new Error('flaky')
        },
        retry: 1,
        retryDelay: 10,
      }),
    )
    const outcome = entry.startFetch().catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1) // attempt 0 failed; the backoff ends at t=10
    setTimeout(() => entry.cancel(), 11)
    // One synchronous advance fires the backoff (t=10) and the cancel (t=11)
    // before the retry loop's continuation gets a microtask.
    vi.advanceTimersByTime(20)
    await vi.advanceTimersByTimeAsync(0)
    const err = await outcome
    expect(isAbortError(err)).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('structural sharing', () => {
  test('switched off, every refetch delivers the object the fetcher returned', async () => {
    const made: Array<{ a: number }> = []
    const fetcher = () => async () => {
      const v = { a: 1 }
      made.push(v)
      return v
    }
    const off = keep(new Entry<{ a: number }>({ fetcher, structuralShare: false }))
    await off.startFetch()
    const second = await off.refetch()
    expect(second).toBe(made[1])
    expect(off.data.peek()).toBe(made[1])

    // On (the default), an equal payload keeps the first reference.
    const on = keep(new Entry<{ a: number }>({ fetcher }))
    await on.startFetch()
    await on.refetch()
    expect(on.data.peek()).toBe(made[2])
  })
})

describe('invalidate', () => {
  test('marks a subscribed query stale before its refetch lands', async () => {
    const { gates, fetch } = gated<string>()
    const q = defineQuery({
      id: 'mutants-entry/invalidate-marks-stale',
      key: () => ['k'],
      fetcher: fetch,
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q), h: bindQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    gates[0]?.resolve('a')
    await flushMicrotasks()
    expect(root.api.s.isStale.value).toBe(false)

    const done = root.api.h.invalidate()
    expect(root.api.s.isStale.value).toBe(true)
    expect(root.api.s.isFetching.value).toBe(true)
    gates[1]?.resolve('b')
    await done
    expect(root.api.s.data.value).toBe('b')
    expect(root.api.s.isStale.value).toBe(false)
  })
})

describe('writes', () => {
  test('a canonical write and an optimistic setData both stamp lastUpdatedAt with the write time', async () => {
    vi.useFakeTimers()
    const q = defineQuery({
      id: 'mutants-entry/write-stamp',
      key: () => ['k'],
      fetcher: async () => 'fetched',
      staleTime: 60_000,
    })
    const root = keep(
      createRoot(
        defineController((ctx) => ({ s: createQuery(ctx, q), h: bindQuery(ctx, q) })),
        { queries: queryEngine(), deps: {} },
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    const fetchedAt = root.api.s.lastUpdatedAt.value as number
    expect(fetchedAt).toBe(Date.now())

    await vi.advanceTimersByTimeAsync(5_000)
    root.api.h.write(() => 'written')
    expect(root.api.s.lastUpdatedAt.value).toBe(fetchedAt + 5_000)

    await vi.advanceTimersByTimeAsync(5_000)
    root.api.h.setData(() => 'optimistic').finalize()
    expect(root.api.s.lastUpdatedAt.value).toBe(fetchedAt + 10_000)
  })

  test('a canonical setData on the entry returns a snapshot whose rollback and finalize do nothing', async () => {
    const entry = keep(new Entry<number>({ fetcher: () => async () => 1 }))
    await entry.startFetch()
    const snap = entry.setData(() => 2, { track: false })
    expect(() => {
      snap.rollback()
      snap.finalize()
    }).not.toThrow()
    expect(entry.data.peek()).toBe(2)
    expect(entry.hasPendingMutations.peek()).toBe(false)
  })
})

describe('a disposed entry', () => {
  test('ignores a hydration', async () => {
    const entry = new Entry<number>({ fetcher: () => async () => 1, staleTime: 60_000 })
    await entry.startFetch()
    const fetchedAt = entry.lastUpdatedAt.peek()
    entry.dispose()
    entry.applyHydration(2, Date.now() + 1)
    expect(entry.data.peek()).toBe(1)
    expect(entry.lastUpdatedAt.peek()).toBe(fetchedAt)
  })

  test('ignores markStale', async () => {
    const entry = new Entry<number>({ fetcher: () => async () => 1, staleTime: 60_000 })
    await entry.startFetch()
    entry.dispose()
    entry.markStale()
    expect(entry.isStale.peek()).toBe(false)
    expect(entry.isStaleNow()).toBe(false)
  })

  test('ignores a late optimistic rollback', async () => {
    const entry = new Entry<number>({ fetcher: () => async () => 1 })
    await entry.startFetch()
    const snap = entry.setData(() => 2)
    entry.dispose()
    snap.rollback()
    expect(entry.data.peek()).toBe(2)
  })

  test('mid-load reads neither loading nor fetching', () => {
    const { fetch } = gated<number>()
    const entry = new Entry<number>({ fetcher: () => fetch })
    entry.startFetch().catch(() => {})
    expect(entry.isLoading.peek()).toBe(true)
    entry.dispose()
    expect(entry.isLoading.peek()).toBe(false)
    expect(entry.isFetching.peek()).toBe(false)
  })

  test('rejects a pending firstValue with an AbortError', async () => {
    const { fetch } = gated<number>()
    const entry = new Entry<number>({ fetcher: () => fetch })
    entry.startFetch().catch(() => {})
    const first = entry.firstValue().catch((e: unknown) => e)
    entry.dispose()
    const err = await first
    expect(err).toBeInstanceOf(DOMException)
    expect((err as DOMException).name).toBe('AbortError')
  })

  // A status subscriber that restarts the fetch synchronously on a settle can
  // leave a later firstValue caller waiting on the restart while an earlier one
  // has already settled. That caller must still be rejected on dispose.
  for (const outcome of ['error', 'success'] as const) {
    test(`rejects a firstValue still waiting after an earlier one settled on ${outcome}`, async () => {
      const { gates, fetch } = gated<number>()
      const entry = new Entry<number>({ fetcher: () => fetch })
      entry.startFetch().catch(() => {})
      const earlier = track(entry.firstValue())
      let restarted = false
      entry.status.subscribe((s) => {
        if (s === outcome && !restarted) {
          restarted = true
          entry.startFetch().catch(() => {})
        }
      })
      const later = track(entry.firstValue())
      if (outcome === 'error') gates[0]?.reject(new Error('down'))
      else gates[0]?.resolve(1)
      await flushMicrotasks()
      expect(earlier.state).toBe(outcome === 'error' ? 'rejected' : 'fulfilled')
      expect(later.state).toBe('pending') // waiting on the restarted fetch

      entry.dispose()
      await flushMicrotasks()
      expect(later.state).toBe('rejected')
      expect(isAbortError(later.error)).toBe(true)
    })
  }
})
