// @vitest-environment jsdom
/**
 * Staleness follows the server's clock, not an optimistic write (SPEC §5.9, §6.4).
 *
 * An optimistic `setData` moved `lastUpdatedAt`, and the subscribe-time staleness check
 * read `lastUpdatedAt`. A guess therefore reset the entry's freshness: past `staleTime`,
 * a new subscriber skipped its refetch while the write was live, after it rolled back
 * (showing old server data as fresh) and after it was finalized. The `isStale` signal
 * read `true` in all three, so the signal and the refetch decision disagreed.
 *
 * Now a fetch, a hydrated row or a canonical write sets the clock, and a guess does not.
 * A subscriber, a focus or a prefetch that finds the entry stale while a guess is live
 * does not fetch then, because the response would land over the guess on screen. The
 * entry runs that fetch once the last live guess settles, if someone still holds it.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  bindQuery,
  createCache,
  createMutation,
  createQuery,
  type InfiniteQuery,
  type Query,
} from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

/** A query whose nth fetch resolves `server-n`, recording each fetch's signal. */
function counted(
  id: string,
  options: { staleTime?: number; refetchOnWindowFocus?: boolean } = {},
): { q: Query<[], string>; signals: AbortSignal[] } {
  const signals: AbortSignal[] = []
  const q = defineQuery({
    id,
    key: () => ['k'],
    fetcher: async ({ signal }) => {
      signals.push(signal)
      return `server-${signals.length}`
    },
    staleTime: 1_000,
    ...options,
  })
  return { q, signals }
}

/**
 * A root that subscribes to `q` (unless `holder` is false), and can attach a child
 * that subscribes too: the subscriber that arrives later.
 */
function mount(q: Query<[], string>, holder = true) {
  const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
  const root = createRoot(
    defineController((ctx) => ({
      s: holder ? createQuery(ctx, q) : undefined,
      open: () => ctx.attach(child, undefined),
    })),
    { queries: queryEngine(), deps: {} },
  )
  return { root, handle: root.bindQuery(q) }
}

describe('a subscriber past staleTime refetches whatever optimistic writes did', () => {
  test('with no optimistic write, the arriving subscriber refetches (control)', async () => {
    const { q, signals } = counted('optimistic-staleness/control')
    const { root } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(root.api.s?.isStale.value).toBe(true)
    const child = root.api.open()
    await flush()
    expect(signals).toHaveLength(2)
    expect(child.api.s.data.value).toBe('server-2')
    root.dispose()
  })

  test('a rolled-back optimistic write: the arriving subscriber refetches', async () => {
    const { q, signals } = counted('optimistic-staleness/rolled-back')
    const { root, handle } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    handle.setData(() => 'guess').rollback()
    expect(root.api.s?.data.value).toBe('server-1')
    // The signal and the refetch decision agree: the server data is 2 s old.
    expect(root.api.s?.isStale.value).toBe(true)
    const child = root.api.open()
    await flush()
    expect(signals).toHaveLength(2)
    expect(child.api.s.data.value).toBe('server-2')
    expect(root.api.s?.isStale.value).toBe(false)
    root.dispose()
  })

  test('a finalized optimistic write: the arriving subscriber refetches', async () => {
    const { q, signals } = counted('optimistic-staleness/finalized')
    const { root, handle } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    handle.setData(() => 'guess').finalize()
    expect(root.api.s?.isStale.value).toBe(true)
    const child = root.api.open()
    await flush()
    expect(signals).toHaveLength(2)
    expect(child.api.s.data.value).toBe('server-2')
    root.dispose()
  })

  test.each(['rollback', 'finalize'] as const)(
    'a live optimistic write: the arriving subscriber waits for it, then one fetch runs after %s',
    async (settle) => {
      const { q, signals } = counted(`optimistic-staleness/live-${settle}`)
      const { root, handle } = mount(q)
      await flush()
      await vi.advanceTimersByTimeAsync(2_000)
      const snapshot = handle.setData(() => 'guess')
      const child = root.api.open()
      await flush()
      // A fetch now would land over the guess on screen.
      expect(signals).toHaveLength(1)
      expect(child.api.s.data.value).toBe('guess')
      expect(child.api.s.isStale.value).toBe(true)
      snapshot[settle]()
      await flush()
      expect(signals).toHaveLength(2)
      expect(child.api.s.data.value).toBe('server-2')
      expect(child.api.s.isStale.value).toBe(false)
      await flush()
      expect(signals).toHaveLength(2)
      root.dispose()
    },
  )

  test('the fetch held back by a live write needs a holder when the write settles', async () => {
    const { q, signals } = counted('optimistic-staleness/unheld')
    const { root, handle } = mount(q, false)
    const first = root.api.open()
    await flush()
    first.dispose()
    await vi.advanceTimersByTimeAsync(2_000)
    const snapshot = handle.setData(() => 'guess')
    const second = root.api.open()
    await flush()
    expect(signals).toHaveLength(1)
    second.dispose()
    snapshot.finalize()
    await flush()
    // Nobody holds the entry, so nothing fetches...
    expect(signals).toHaveLength(1)
    // ...and the next subscriber still finds it stale.
    const third = root.api.open()
    await flush()
    expect(signals).toHaveLength(2)
    expect(third.api.s.data.value).toBe('server-2')
    root.dispose()
  })

  test('an invalidation still standing wins over a live write', async () => {
    const { q, signals } = counted('optimistic-staleness/invalidated', {
      staleTime: Number.POSITIVE_INFINITY,
    })
    const { root, handle } = mount(q, false)
    const first = root.api.open()
    await flush()
    first.dispose()
    // Nobody subscribes, so the invalidation only marks the entry stale.
    await handle.invalidate()
    expect(signals).toHaveLength(1)
    const snapshot = handle.setData(() => 'guess')
    const second = root.api.open()
    await flush()
    expect(signals).toHaveLength(2)
    expect(second.api.s.data.value).toBe('server-2')
    snapshot.finalize()
    await flush()
    expect(signals).toHaveLength(2)
    root.dispose()
  })
})

describe('fresh data stays fresh', () => {
  test('an optimistic write inside staleTime settles without a fetch', async () => {
    const { q, signals } = counted('optimistic-staleness/fresh', { staleTime: 10_000 })
    const { root, handle } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(1_000)
    const snapshot = handle.setData(() => 'guess')
    const child = root.api.open()
    await flush()
    expect(child.api.s.isStale.value).toBe(false)
    snapshot.finalize()
    await flush()
    expect(signals).toHaveLength(1)
    expect(child.api.s.data.value).toBe('guess')
    root.dispose()
  })

  test('with staleTime 0, a write that no subscriber waited on settles without a fetch', async () => {
    const { q, signals } = counted('optimistic-staleness/quiet', { staleTime: 0 })
    const { root, handle } = mount(q)
    await flush()
    handle.setData(() => 'guess').finalize()
    handle.setData(() => 'second guess').rollback()
    await flush()
    // Settling is not a refetch trigger of its own (§5.9): only a held-back fetch runs.
    expect(signals).toHaveLength(1)
    root.dispose()
  })
})

describe('an optimistic write leaves the stale clock alone', () => {
  test('it neither restarts the timer nor clears isStale, and lastUpdatedAt still moves', async () => {
    const { q } = counted('optimistic-staleness/timer')
    const { root, handle } = mount(q)
    await flush()
    const fetchedAt = root.api.s?.lastUpdatedAt.value as number
    await vi.advanceTimersByTimeAsync(900)
    const snapshot = handle.setData(() => 'guess')
    expect(root.api.s?.lastUpdatedAt.value).toBe(fetchedAt + 900)
    expect(root.api.s?.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(root.api.s?.isStale.value).toBe(true)
    snapshot.finalize()
    expect(root.api.s?.isStale.value).toBe(true)
    root.dispose()
  })

  test('a canonical write restarts the stale window, as the refetch decision already did', async () => {
    const { q, signals } = counted('optimistic-staleness/canonical')
    const { root, handle } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(root.api.s?.isStale.value).toBe(true)
    handle.write(() => 'pushed')
    expect(root.api.s?.isStale.value).toBe(false)
    const child = root.api.open()
    await flush()
    expect(signals).toHaveLength(1)
    expect(child.api.s.data.value).toBe('pushed')
    await vi.advanceTimersByTimeAsync(999)
    expect(root.api.s?.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(root.api.s?.isStale.value).toBe(true)
    root.dispose()
  })

  test('a local cache keeps the same clock', async () => {
    let calls = 0
    const root = createRoot(
      defineController((ctx) => ({
        c: createCache(ctx, async () => `server-${++calls}`, { staleTime: 1_000 }),
      })),
      { deps: {} },
    )
    await flush()
    await vi.advanceTimersByTimeAsync(900)
    const snapshot = root.api.c.setData(() => 'guess')
    await vi.advanceTimersByTimeAsync(100)
    expect(root.api.c.isStale.value).toBe(true)
    snapshot.finalize()
    await flush()
    // A local cache fetches on its key, not on staleness, so settling fetches nothing.
    expect(calls).toBe(1)
    root.api.c.write(() => 'pushed')
    expect(root.api.c.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(root.api.c.isStale.value).toBe(true)
    root.dispose()
  })
})

describe('a mutation that invalidates as it settles makes one request', () => {
  test.each([
    ['onSuccess', true],
    ['onSettled', true],
    ['onSettled', false],
  ] as const)('%s invalidates (the mutation succeeds: %s)', async (hook, succeeds) => {
    const { q, signals } = counted(`optimistic-staleness/mutation-${hook}-${succeeds}`)
    let finish: () => void = () => {}
    const child = defineController((ctx) => ({ s: createQuery(ctx, q) }))
    const root = createRoot(
      defineController((ctx) => {
        const handle = bindQuery(ctx, q)
        const invalidate = (): void => {
          void handle.invalidate()
        }
        return {
          s: createQuery(ctx, q),
          open: () => ctx.attach(child, undefined),
          save: createMutation(ctx, {
            mutate: () =>
              new Promise<void>((resolve, reject) => {
                finish = succeeds ? resolve : () => reject(new Error('refused'))
              }),
            // The recipe: cancel, then guess (§6.4).
            onMutate: () => {
              handle.cancel()
              return handle.setData(() => 'guess')
            },
            ...(hook === 'onSuccess' ? { onSuccess: invalidate } : { onSettled: invalidate }),
          }),
        }
      }),
      { queries: queryEngine(), deps: {} },
    )
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    const run = root.api.save.run(undefined).catch(() => {})
    const opened = root.api.open()
    await flush()
    expect(signals).toHaveLength(1)
    finish()
    await run
    await flush()
    expect(signals).toHaveLength(2)
    expect(signals.some((s) => s.aborted)).toBe(false)
    expect(opened.api.s.data.value).toBe('server-2')
    root.dispose()
  })
})

describe('triggers during a live optimistic write', () => {
  test('a focus waits for the write to settle, and two focuses make one fetch', async () => {
    const { q, signals } = counted('optimistic-staleness/focus', { refetchOnWindowFocus: true })
    const { root, handle } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    const snapshot = handle.setData(() => 'guess')
    window.dispatchEvent(new Event('focus'))
    await flush()
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(signals).toHaveLength(1)
    expect(root.api.s?.data.value).toBe('guess')
    snapshot.finalize()
    await flush()
    expect(signals).toHaveLength(2)
    expect(root.api.s?.data.value).toBe('server-2')
    root.dispose()
  })

  test('a prefetch resolves with the guess and fetches after the write settles', async () => {
    const { q, signals } = counted('optimistic-staleness/prefetch')
    const { root, handle } = mount(q)
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    const snapshot = handle.setData(() => 'guess')
    await expect(handle.prefetch()).resolves.toBe('guess')
    expect(signals).toHaveLength(1)
    snapshot.rollback()
    await flush()
    expect(signals).toHaveLength(2)
    expect(root.api.s?.data.value).toBe('server-2')
    root.dispose()
  })
})

// ─── infinite queries ────────────────────────────────────────────────────────

type Page = { n: number; v: string }

/** A one-page feed whose nth fetch reads `server-n`. */
function countedFeed(id: string): {
  feed: InfiniteQuery<[], Page, Page>
  signals: AbortSignal[]
} {
  const signals: AbortSignal[] = []
  const feed = defineInfiniteQuery({
    id,
    key: () => ['feed'],
    fetcher: async ({ pageParam, signal }: { pageParam: number; signal: AbortSignal }) => {
      signals.push(signal)
      return { n: pageParam, v: `server-${signals.length}` }
    },
    initialPageParam: 0,
    getNextPageParam: (last: Page) => (last.n < 3 ? last.n + 1 : null),
    staleTime: 1_000,
  })
  return { feed, signals }
}

function mountFeed(feed: InfiniteQuery<[], Page, Page>) {
  const child = defineController((ctx) => ({ f: createQuery(ctx, feed) }))
  const root = createRoot(
    defineController((ctx) => ({
      f: createQuery(ctx, feed),
      open: () => ctx.attach(child, undefined),
    })),
    { queries: queryEngine(), deps: {} },
  )
  return { root, handle: root.bindQuery(feed) }
}

const guess = (): Page[] => [{ n: 0, v: 'guess' }]

describe('infinite queries: a subscriber past staleTime refetches whatever optimistic writes did', () => {
  test.each(['rollback', 'finalize'] as const)(
    'a settled (%s) optimistic write: the arriving subscriber refetches',
    async (settle) => {
      const { feed, signals } = countedFeed(`optimistic-staleness/infinite-settled-${settle}`)
      const { root, handle } = mountFeed(feed)
      await flush()
      await vi.advanceTimersByTimeAsync(2_000)
      handle.setData(guess)[settle]()
      expect(root.api.f.isStale.value).toBe(true)
      const child = root.api.open()
      await flush()
      expect(signals).toHaveLength(2)
      expect(child.api.f.pages.value[0]?.v).toBe('server-2')
      root.dispose()
    },
  )

  test.each(['rollback', 'finalize'] as const)(
    'a live optimistic write: the arriving subscriber waits, then one refetch runs after %s',
    async (settle) => {
      const { feed, signals } = countedFeed(`optimistic-staleness/infinite-live-${settle}`)
      const { root, handle } = mountFeed(feed)
      await flush()
      await vi.advanceTimersByTimeAsync(2_000)
      const snapshot = handle.setData(guess)
      const child = root.api.open()
      await flush()
      expect(signals).toHaveLength(1)
      expect(child.api.f.pages.value[0]?.v).toBe('guess')
      expect(child.api.f.isStale.value).toBe(true)
      snapshot[settle]()
      await flush()
      expect(signals).toHaveLength(2)
      expect(child.api.f.pages.value[0]?.v).toBe('server-2')
      root.dispose()
    },
  )

  test('an optimistic write leaves the clock alone; a page fetch and a canonical write restart it', async () => {
    const { feed } = countedFeed('optimistic-staleness/infinite-clock')
    const { root, handle } = mountFeed(feed)
    await flush()
    await vi.advanceTimersByTimeAsync(900)
    const snapshot = handle.setData(guess)
    await vi.advanceTimersByTimeAsync(100)
    expect(root.api.f.isStale.value).toBe(true)
    snapshot.rollback()
    await root.api.f.fetchNextPage()
    expect(root.api.f.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(root.api.f.isStale.value).toBe(true)
    handle.write((pages) => pages ?? [])
    expect(root.api.f.isStale.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(root.api.f.isStale.value).toBe(true)
    root.dispose()
  })
})
