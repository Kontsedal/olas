import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createCache, createQuery, QueryDisabledError } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { signal } from '../src/signals'

const emptyDeps = {}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

describe('a disabled subscription: isEnabled, refetch, firstValue', () => {
  test('regular: isEnabled is false, refetch rejects QueryDisabledError, firstValue waits', async () => {
    const enabled = signal(false)
    const q = defineQuery({
      id: 'use-edges/16',
      key: () => ['unbound'],
      fetcher: async () => 'loaded',
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.x.isEnabled.value).toBe(false)
    const refetch = root.api.x.refetch()
    await expect(refetch).rejects.toBeInstanceOf(QueryDisabledError)
    await expect(refetch).rejects.toMatchObject({ queryId: 'use-edges/16' })

    // firstValue does not reject while disabled: it resolves once the
    // subscription is enabled and the entry loads.
    let settled: unknown = 'pending'
    const first = root.api.x.firstValue().then((v) => {
      settled = v
    })
    await flush()
    expect(settled).toBe('pending')
    // Asked again while pending, it is the same promise, so a suspended render
    // that re-throws does not mint a new one.
    expect(root.api.x.firstValue()).toBe(root.api.x.firstValue())
    enabled.set(true)
    expect(root.api.x.isEnabled.value).toBe(true)
    await first
    expect(settled).toBe('loaded')
    root.dispose()
  })

  test('regular: a firstValue waiting on a disabled subscription rejects on dispose', async () => {
    const q = defineQuery({
      id: 'use-edges/disposed-wait',
      key: () => [],
      fetcher: async () => 'never',
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { enabled: () => false }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    const waiting = root.api.x.firstValue()
    root.dispose()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('infinite: the same contract, and fetchNextPage stays a silent no-op', async () => {
    const enabled = signal(false)
    const q = defineInfiniteQuery({
      id: 'use-edges/31',
      key: () => ['unbound-inf'],
      fetcher: async () => 'page',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    expect(root.api.x.isEnabled.value).toBe(false)
    await expect(root.api.x.refetch()).rejects.toBeInstanceOf(QueryDisabledError)
    // fetchNextPage / fetchPreviousPage are silent no-ops without a current entry.
    await expect(root.api.x.fetchNextPage()).resolves.toBeUndefined()
    await expect(root.api.x.fetchPreviousPage()).resolves.toBeUndefined()
    const first = root.api.x.firstValue()
    enabled.set(true)
    await expect(first).resolves.toEqual(['page'])
    root.dispose()
  })
})

describe('enabled gate flip causes detach + attach', () => {
  test('regular: detaches when enabled flips false, re-attaches when true', async () => {
    let fetches = 0
    const enabled = signal(true)
    const q = defineQuery({
      id: 'use-edges/55',
      key: () => ['toggleable'],
      fetcher: async () => ++fetches,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(1))

    enabled.set(false)
    await flush()
    expect(root.api.x.status.value).toBe('idle')

    enabled.set(true)
    await vi.waitFor(() => expect(root.api.x.data.value).toBe(2))
    root.dispose()
  })

  test('infinite: detaches when enabled flips false', async () => {
    const enabled = signal(true)
    const q = defineInfiniteQuery({
      id: 'use-edges/76',
      key: () => ['toggle-inf'],
      fetcher: async ({ pageParam }: { pageParam: number }) => `p${pageParam}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.waitFor(() => expect(root.api.x.pages.value).toEqual(['p0']))

    enabled.set(false)
    await flush()
    // After detach the subscription's pages signal still returns the default
    // empty array (no current entry).
    expect(root.api.x.pages.value).toEqual([])
    expect(root.api.x.status.value).toBe('idle')
    root.dispose()
  })
})

describe('root.suspend / root.resume with an infinite subscription', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('suspend releases the entry; resume rebinds and refetches when stale', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'use-edges/104',
      key: () => ['suspend-inf'],
      fetcher: async ({ pageParam }: { pageParam: number }) => {
        calls++
        return `p${pageParam}-${calls}`
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      // staleTime=0 → resume triggers refetch.
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    root.suspend()
    // While suspended the subscription detaches; current is null.
    root.resume()
    await vi.advanceTimersByTimeAsync(0)
    // resume re-binds and triggers a refetch since data is stale (staleTime=0).
    expect(calls).toBe(2)
    root.dispose()
  })

  test('resume short-circuits when the controller is enabled=false', async () => {
    let calls = 0
    const enabled = signal(false)
    const q = defineInfiniteQuery({
      id: 'use-edges/131',
      key: () => ['suspend-disabled'],
      fetcher: async () => {
        calls++
        return 'page'
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, { key: () => [], enabled: () => enabled.value }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(0)
    root.suspend()
    root.resume()
    // Still disabled → resume does nothing.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(0)
    root.dispose()
  })

  test('suspend is a no-op when already suspended; resume is a no-op when not suspended', async () => {
    const q = defineInfiniteQuery({
      id: 'use-edges/155',
      key: () => ['idem'],
      fetcher: async () => 'page',
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const def = defineController((ctx) => ({ x: createQuery(ctx, q) }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await vi.advanceTimersByTimeAsync(0)
    // Double suspend / double resume should not throw or fetch extra.
    root.suspend()
    root.suspend()
    root.resume()
    root.resume()
    root.dispose()
  })
})

describe('keepPreviousData does not leak into a disabled subscription', () => {
  // `keepPreviousData` bridges a key change. It used to also fill the gap while
  // a subscription was disabled, with whatever key it had retained last, and a
  // re-enable skipped the data shown just before the disable (§5.2).
  const gate = () => {
    let resolve: (v: string) => void = () => {}
    const promise = new Promise<string>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }
  const setup = (id: string, keepDataWhileDisabled = false) => {
    const gates: Record<string, ReturnType<typeof gate>> = {}
    const q = defineQuery({
      id,
      key: (k: string) => [k],
      fetcher: (_ctx, k: string) => {
        const g = gate()
        gates[k] = g
        return g.promise
      },
      keepPreviousData: true,
    })
    const key = signal('a')
    const enabled = signal(true)
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, {
        key: () => [key.value] as [string],
        enabled: () => enabled.value,
        keepDataWhileDisabled,
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    return { root, key, enabled, gates }
  }

  test('the reviewer reproduction: a → b → disabled reads undefined', async () => {
    const { root, key, enabled, gates } = setup('use-edges/kpd-disabled')
    gates.a?.resolve('data-a')
    await flush()
    key.set('b')
    gates.b?.resolve('data-b')
    await flush()
    expect(root.api.x.data.value).toBe('data-b')
    enabled.set(false)
    expect(root.api.x.data.value).toBeUndefined()
    root.dispose()
  })

  test('a re-enable on a new key bridges with the data shown before the disable', async () => {
    const { root, key, enabled, gates } = setup('use-edges/kpd-reenable')
    gates.a?.resolve('data-a')
    await flush()
    key.set('b')
    gates.b?.resolve('data-b')
    await flush()
    enabled.set(false)
    key.set('c')
    enabled.set(true)
    // `c` is loading: the bridge shows `b`, the last data this subscription held.
    expect(root.api.x.data.value).toBe('data-b')
    expect(root.api.x.isLoading.value).toBe(false)
    gates.c?.resolve('data-c')
    await flush()
    expect(root.api.x.data.value).toBe('data-c')
    root.dispose()
  })

  test('keepDataWhileDisabled keeps the data shown at the disable, even a bridged one', async () => {
    const { root, key, enabled, gates } = setup('use-edges/kpd-keep-bridge', true)
    gates.a?.resolve('data-a')
    await flush()
    key.set('b')
    // `b` has not loaded: the subscription shows the bridged `a`.
    expect(root.api.x.data.value).toBe('data-a')
    enabled.set(false)
    expect(root.api.x.data.value).toBe('data-a')
    root.dispose()
  })

  test('infinite: a → b → disabled reads undefined', async () => {
    const q = defineInfiniteQuery({
      id: 'use-edges/kpd-disabled-infinite',
      key: (k: string) => [k],
      fetcher: async (_ctx, k: string) => `page-${k}`,
      initialPageParam: 0,
      getNextPageParam: () => null,
      keepPreviousData: true,
    })
    const key = signal('a')
    const enabled = signal(true)
    const def = defineController((ctx) => ({
      x: createQuery(ctx, q, {
        key: () => [key.value] as [string],
        enabled: () => enabled.value,
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: emptyDeps })
    await flush()
    key.set('b')
    await flush()
    expect(root.api.x.pages.value).toEqual(['page-b'])
    enabled.set(false)
    expect(root.api.x.data.value).toBeUndefined()
    expect(root.api.x.pages.value).toEqual([])
    expect(root.api.x.flat.value).toEqual([])
    root.dispose()
  })
})

describe('resume joins a fetch already in flight', () => {
  // The effect path skips a fetch while one runs. `resume()` did not, so a
  // suspend and resume during a first fetch aborted it and fetched again.
  test('regular: suspend/resume mid-fetch runs the fetcher once', async () => {
    let calls = 0
    let aborts = 0
    const q = defineQuery({
      id: 'use-edges/resume-join',
      key: () => [],
      fetcher: ({ signal: s }) => {
        calls += 1
        s.addEventListener('abort', () => {
          aborts += 1
        })
        return new Promise<string>((r) => setTimeout(() => r('loaded'), 10))
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root.suspend()
    root.resume()
    await vi.waitFor(() => expect(root.api.x.data.value).toBe('loaded'))
    expect(calls).toBe(1)
    expect(aborts).toBe(0)
    root.dispose()
  })

  test('infinite: suspend/resume mid-fetch runs the fetcher once', async () => {
    let calls = 0
    let aborts = 0
    const q = defineInfiniteQuery({
      id: 'use-edges/resume-join-infinite',
      key: () => [],
      fetcher: ({ signal: s }) => {
        calls += 1
        s.addEventListener('abort', () => {
          aborts += 1
        })
        return new Promise<string>((r) => setTimeout(() => r('page'), 10))
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root.suspend()
    root.resume()
    await vi.waitFor(() => expect(root.api.x.pages.value).toEqual(['page']))
    expect(calls).toBe(1)
    expect(aborts).toBe(0)
    root.dispose()
  })
})

describe('firstValue resolves at once when data is present', () => {
  // Its TSDoc and §6.4 say "holds data" means `!== undefined`. A background
  // refetch sets `status: 'pending'` over data, and `firstValue()` used to wait
  // for that refetch instead of resolving with the data on hand.
  /** `promise`'s value, or `'waiting'` when it has not settled within a macrotask. */
  const withinATurn = (promise: Promise<unknown>): Promise<unknown> =>
    Promise.race([promise, new Promise((r) => setTimeout(() => r('waiting'), 0))])
  test('regular: during a background refetch', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'use-edges/first-value-data',
      key: () => [],
      fetcher: () => {
        calls += 1
        return calls === 1 ? Promise.resolve('first') : new Promise<string>(() => {})
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await flush()
    void root.api.x.refetch()
    expect(root.api.x.status.value).toBe('pending')
    expect(await withinATurn(root.api.x.firstValue())).toBe('first')
    root.dispose()
  })

  test('regular: after a failed background refetch that kept the data', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'use-edges/first-value-error-data',
      key: () => [],
      fetcher: async () => {
        calls += 1
        if (calls > 1) throw new Error('blip')
        return 'first'
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps, onError: () => {} },
    )
    await flush()
    await root.api.x.refetch().catch(() => {})
    expect(root.api.x.status.value).toBe('error')
    await expect(root.api.x.firstValue()).resolves.toBe('first')
    root.dispose()
  })

  test('infinite: during a background refetch', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'use-edges/first-value-data-infinite',
      key: () => [],
      fetcher: () => {
        calls += 1
        return calls === 1 ? Promise.resolve('page') : new Promise<string>(() => {})
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await flush()
    void root.api.x.refetch()
    expect(await withinATurn(root.api.x.firstValue())).toEqual(['page'])
    root.dispose()
  })

  test('a local cache: during a background refetch', async () => {
    let calls = 0
    const def = defineController((ctx) => ({
      c: createCache(ctx, () => {
        calls += 1
        return calls === 1 ? Promise.resolve('first') : new Promise<string>(() => {})
      }),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    void root.api.c.refetch()
    expect(await withinATurn(root.api.c.firstValue())).toBe('first')
    root.dispose()
  })

  test('a superseded refetch still resolves with the fetch that superseded it', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'use-edges/refetch-supersede',
      key: () => [],
      fetcher: async () => {
        calls += 1
        return `fetch ${calls}`
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await flush()
    const first = root.api.x.refetch()
    const second = root.api.x.refetch()
    await expect(first).resolves.toBe('fetch 3')
    await expect(second).resolves.toBe('fetch 3')
    root.dispose()
  })

  // With `keepPreviousData`, a local cache keeps the previous key's data on
  // screen after a key change. `firstValue()` resolved with it at once, so a
  // navigation guard read the old key's data. A shared query's subscription
  // waits for the new key in the same case, and now so does the local cache.
  test("a local cache with keepPreviousData: after a key change, not the old key's data", async () => {
    const key = signal('a')
    const pending: Array<(v: string) => void> = []
    const def = defineController((ctx) => ({
      c: createCache(
        ctx,
        () => {
          const k = key.peek()
          return new Promise<string>((r) => pending.push(() => r(`data for ${k}`)))
        },
        { key: () => [key.value], keepPreviousData: true },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    pending[0]?.('')
    await flush()
    expect(root.api.c.data.value).toBe('data for a')
    key.set('b')
    // The old key's data stays on screen.
    expect(root.api.c.data.value).toBe('data for a')
    const first = root.api.c.firstValue()
    expect(await withinATurn(first)).toBe('waiting')
    pending[1]?.('')
    await expect(first).resolves.toBe('data for b')
    // Once the new key's data is in, it resolves at once again.
    expect(await withinATurn(root.api.c.firstValue())).toBe('data for b')
    root.dispose()
  })

  test('a local cache with keepPreviousData: a failed fetch for the new key rejects', async () => {
    const key = signal('a')
    const def = defineController((ctx) => ({
      c: createCache(
        ctx,
        async () => {
          if (key.peek() === 'b') throw new Error('no b')
          return 'data for a'
        },
        { key: () => [key.value], keepPreviousData: true },
      ),
    }))
    const root = createRoot(def, { deps: emptyDeps })
    await flush()
    key.set('b')
    await expect(root.api.c.firstValue()).rejects.toThrow('no b')
    root.dispose()
  })
})

// `cancel()` on a first load left the entry idle with no fetch coming, and a
// `firstValue()` waiting on it never settled: a Suspense boundary kept its
// fallback up for good (§5.3). It now never waits on nothing.
describe('firstValue never waits on nothing', () => {
  /** A query whose first fetch hangs until released; later ones resolve `second`. */
  function hangingFirst(id: string) {
    let calls = 0
    const q = defineQuery({
      id,
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('second')
      },
    })
    return { q, calls: () => calls }
  }

  test('a cancelled first load fetches again for the waiting firstValue', async () => {
    const { q, calls } = hangingFirst('use-edges/first-value-cancel')
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const first = root.api.x.firstValue()
    // The waiter is on the entry before the cancel, as a suspended render's is.
    await flush()
    root.api.x.cancel()
    await expect(first).resolves.toBe('second')
    expect(calls()).toBe(2)
    root.dispose()
  })

  test('a firstValue asked for after the cancel fetches too', async () => {
    const { q, calls } = hangingFirst('use-edges/first-value-after-cancel')
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root.api.x.cancel()
    expect(root.api.x.status.value).toBe('idle')
    await expect(root.api.x.firstValue()).resolves.toBe('second')
    expect(calls()).toBe(2)
    root.dispose()
  })

  test('the setData that follows a cancel resolves it, and nothing refetches', async () => {
    const { q, calls } = hangingFirst('use-edges/first-value-cancel-guess')
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const first = root.api.x.firstValue()
    await flush()
    const handle = root.bindQuery(q)
    handle.cancel()
    handle.setData(() => 'guess')
    await expect(first).resolves.toBe('guess')
    await flush()
    expect(calls()).toBe(1)
    root.dispose()
  })

  test('called on an idle entry after a reset of a failed first load, it fetches', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'use-edges/first-value-reset',
      key: () => ['k'],
      fetcher: async () => {
        calls += 1
        if (calls === 1) throw new Error('first load failed')
        return 'loaded'
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    await expect(root.api.x.firstValue()).rejects.toThrow('first load failed')
    root.api.x.reset()
    expect(root.api.x.status.value).toBe('idle')
    await expect(root.api.x.firstValue()).resolves.toBe('loaded')
    expect(calls).toBe(2)
    root.dispose()
  })

  test('infinite: a cancelled first load fetches again for the waiting firstValue', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'use-edges/first-value-cancel-infinite',
      key: () => ['k'],
      fetcher: ({ pageParam }: { pageParam: number }) => {
        calls += 1
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve(`p${pageParam}`)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    const first = root.api.x.firstValue()
    await flush()
    root.api.x.cancel()
    await expect(first).resolves.toEqual(['p0'])
    expect(calls).toBe(2)
    root.dispose()
  })

  test('infinite: a firstValue asked for after the cancel fetches too', async () => {
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'use-edges/first-value-after-cancel-infinite',
      key: () => ['k'],
      fetcher: ({ pageParam }: { pageParam: number }) => {
        calls += 1
        return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve(`p${pageParam}`)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ x: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: emptyDeps },
    )
    root.api.x.cancel()
    await expect(root.api.x.firstValue()).resolves.toEqual(['p0'])
    expect(calls).toBe(2)
    root.dispose()
  })

  test('a local cache: a cancelled first load fetches again for the waiting firstValue', async () => {
    let calls = 0
    const root = createRoot(
      defineController((ctx) => ({
        x: createCache(ctx, () => {
          calls += 1
          return calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('second')
        }),
      })),
      { deps: emptyDeps },
    )
    const first = root.api.x.firstValue()
    root.api.x.cancel()
    await expect(first).resolves.toBe('second')
    root.dispose()
  })
})
