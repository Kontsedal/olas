/**
 * A `replace` that discards an invalidation's response re-fetches once (SPEC §6.4).
 *
 * `replace` supersedes a fetch in flight, because the fetch was requested before the
 * record it carries. When that fetch is an invalidation's, its response is the
 * reconciliation the invalidation asked for: a reconnect's `invalidateAll()` catching up
 * on what was missed. The write carries only its own record, so without a catch-up the
 * missed data is lost, the entry stays stale, and nothing fetches again.
 */
import { describe, expect, test, vi } from 'vitest'
import { createCache, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { definePlugin } from '../src/plugin/host'
import type { PluginHost } from '../src/plugin/types'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { effect, signal } from '../src/signals'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
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

/**
 * A fetcher answering each call from its own deferred, in call order. It rejects on
 * abort, as a real one does, unless `ignoreAbort`: then a discarded response still
 * arrives, the way one already in transit does.
 */
function scripted<T>(options: { ignoreAbort?: boolean } = {}) {
  const calls: Array<ReturnType<typeof deferred<T>>> = []
  return {
    calls,
    fetcher: ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const d = deferred<T>()
      calls.push(d)
      if (options.ignoreAbort !== true) {
        signal.addEventListener('abort', () => d.reject(new DOMException('Aborted', 'AbortError')))
      }
      return d.promise
    },
    answer(index: number, value: T): void {
      const call = calls[index]
      if (call === undefined) throw new Error(`no fetch #${index} was made`)
      call.resolve(value)
    },
  }
}

describe('a replace that discards an invalidation response catches up', () => {
  test('the reviewer reproduction: the missed server data lands and the entry is fresh', async () => {
    const server = scripted<string>({ ignoreAbort: true })
    const q = defineQuery({
      id: 'catch-up/reproduction',
      key: () => ['k'],
      fetcher: server.fetcher,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()
    const handle = root.bindQuery(q)

    // A reconnect invalidates, to catch up on what was missed while offline...
    let invalidated = false
    const settled = handle.invalidate().then(() => {
      invalidated = true
    })
    expect(server.calls).toHaveLength(2)

    // ...and a push lands while that fetch is in flight. It supersedes the fetch.
    handle.replace('push')
    expect(root.api.s.data.value).toBe('push')

    // The superseded response, carrying the missed data, is discarded.
    server.answer(1, 'v1 + missed')
    await flush()
    expect(root.api.s.data.value).toBe('push')

    // The entry fetches once more, and `await invalidate()` waits for that fetch.
    expect(server.calls).toHaveLength(3)
    expect(root.api.s.isFetching.value).toBe(true)
    expect(invalidated).toBe(false)

    server.answer(2, 'v1 + missed + push')
    await settled
    expect(root.api.s.data.value).toBe('v1 + missed + push')
    expect(root.api.s.isStale.value).toBe(false)
    expect(root.api.s.isFetching.value).toBe(false)
    root.dispose()
  })

  test('a burst of replaces coalesces into one catch-up that is not restarted', async () => {
    const server = scripted<string>()
    const q = defineQuery({ id: 'catch-up/burst', key: () => ['k'], fetcher: server.fetcher })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()
    const handle = root.bindQuery(q)

    const settled = handle.invalidate()
    handle.replace('push 1') // discards the invalidation's fetch: the catch-up starts
    handle.replace('push 2') // lands during the catch-up, and leaves it in flight
    await flush()
    handle.replace('push 3')
    expect(server.calls).toHaveLength(3)
    expect(root.api.s.data.value).toBe('push 3')
    expect(root.api.s.isFetching.value).toBe(true)

    server.answer(2, 'reconciled')
    await settled
    expect(root.api.s.data.value).toBe('reconciled')
    expect(server.calls).toHaveLength(3)
    root.dispose()
  })

  test('isFetching never reads false between the supersede and the catch-up', async () => {
    const server = scripted<string>()
    const q = defineQuery({ id: 'catch-up/no-gap', key: () => ['k'], fetcher: server.fetcher })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()
    const handle = root.bindQuery(q)
    void handle.invalidate()

    const seen: boolean[] = []
    const stop = effect(() => {
      seen.push(root.api.s.isFetching.value)
    })
    let idle = false
    void root.waitForIdle().then(() => {
      idle = true
    })
    handle.replace('push')
    await flush()
    expect(seen).toEqual([true])
    expect(idle).toBe(false)

    server.answer(2, 'reconciled')
    await vi.waitFor(() => expect(idle).toBe(true))
    stop()
    root.dispose()
  })

  test('a failed catch-up reaches onError, and invalidate resolves when it settles', async () => {
    const onError = vi.fn()
    const server = scripted<string>({ ignoreAbort: true })
    const q = defineQuery({ id: 'catch-up/fails', key: () => ['k'], fetcher: server.fetcher })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, onError },
    )
    server.answer(0, 'v1')
    await flush()
    const handle = root.bindQuery(q)

    const settled = handle.invalidate()
    handle.replace('push')
    server.calls[1]?.reject(new Error('the discarded one'))
    await flush()
    expect(onError).not.toHaveBeenCalled()

    const boom = new Error('catch-up failed')
    server.calls[2]?.reject(boom)
    await settled
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(
      boom,
      expect.objectContaining({ kind: 'cache', queryId: 'catch-up/fails', key: ['k'] }),
    )
    expect(root.api.s.status.value).toBe('error')
    expect(root.api.s.data.value).toBe('push')
    root.dispose()
  })

  test('a catch-up superseded by a refetch lets invalidate resolve', async () => {
    const server = scripted<string>()
    const q = defineQuery({ id: 'catch-up/refetched', key: () => ['k'], fetcher: server.fetcher })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()
    const handle = root.bindQuery(q)

    const settled = handle.invalidate()
    handle.replace('push')
    const refetched = root.api.s.refetch() // supersedes the catch-up
    expect(server.calls).toHaveLength(4)
    server.answer(3, 'refetched')
    await settled
    await expect(refetched).resolves.toBe('refetched')
    expect(root.api.s.data.value).toBe('refetched')
    root.dispose()
  })

  test('a replace over a plain refetch does not re-fetch', async () => {
    const server = scripted<string>()
    const q = defineQuery({ id: 'catch-up/plain', key: () => ['k'], fetcher: server.fetcher })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()

    void root.api.s.refetch() // not an invalidation: the entry is not force-stale
    root.bindQuery(q).replace('push')
    server.answer(1, 'late')
    await flush()
    expect(server.calls).toHaveLength(2)
    expect(root.api.s.data.value).toBe('push')
    root.dispose()
  })

  test('an entry nobody subscribes to any more does not re-fetch', async () => {
    const server = scripted<string>()
    const q = defineQuery({
      id: 'catch-up/unwatched',
      key: () => ['k'],
      fetcher: server.fetcher,
      gcTime: 60_000,
    })
    const on = signal(true)
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q, { enabled: () => on.value }) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()
    const handle = root.bindQuery(q)

    const settled = handle.invalidate()
    on.set(false) // releases the entry; its fetch keeps running for the gc window
    handle.replace('push')
    await settled
    expect(server.calls).toHaveLength(2)
    expect(handle.peek()).toBe('push')
    root.dispose()
  })

  test('a subscriber-less invalidation still catches up on the next subscriber fetch', async () => {
    // The invalidation only marks the entry stale, and nothing awaits the fetch the next
    // subscriber starts. A replace discarding that fetch is still discarding the
    // reconciliation, so the entry catches up all the same.
    const server = scripted<string>({ ignoreAbort: true })
    const q = defineQuery({
      id: 'catch-up/late-subscriber',
      key: () => ['k'],
      fetcher: server.fetcher,
      gcTime: 60_000,
    })
    const on = signal(true)
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q, { enabled: () => on.value }) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, 'v1')
    await flush()
    on.set(false)
    const handle = root.bindQuery(q)
    await handle.invalidate() // no subscriber: marked stale only
    expect(server.calls).toHaveLength(1)

    on.set(true) // the new subscriber fetches the stale entry
    expect(server.calls).toHaveLength(2)
    handle.replace('push')
    expect(server.calls).toHaveLength(3)
    server.answer(1, 'discarded')
    server.answer(2, 'reconciled')
    await vi.waitFor(() => expect(root.api.s.data.value).toBe('reconciled'))
    root.dispose()
  })

  test('host.queries.replace catches up as the app-side replace does', async () => {
    const server = scripted<string>()
    const q = defineQuery({ id: 'catch-up/host', key: () => ['k'], fetcher: server.fetcher })
    let host: PluginHost | undefined
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [
          definePlugin({
            name: 'pusher',
            setup: (h) => {
              host = h
            },
          }),
        ],
      },
    )
    server.answer(0, 'v1')
    await flush()

    const settled = host?.queries?.invalidate('catch-up/host', ['k'])
    host?.queries?.replace('catch-up/host', ['k'], 'push')
    expect(server.calls).toHaveLength(3)
    server.answer(2, 'reconciled')
    await settled
    expect(root.api.s.data.value).toBe('reconciled')
    root.dispose()
  })

  test('an infinite query catches up by re-fetching its pages', async () => {
    const server = scripted<number[]>({ ignoreAbort: true })
    const feed = defineInfiniteQuery({
      id: 'catch-up/infinite',
      key: () => ['feed'],
      fetcher: server.fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, [1])
    await flush()
    const handle = root.bindQuery(feed)

    let invalidated = false
    const settled = handle.invalidate().then(() => {
      invalidated = true
    })
    handle.replace([[1, 2]])
    handle.replace([[1, 2, 3]]) // during the catch-up: coalesced
    server.answer(1, [1, 'missed' as unknown as number])
    await flush()
    expect(root.api.f.pages.value).toEqual([[1, 2, 3]])
    expect(server.calls).toHaveLength(3)
    expect(invalidated).toBe(false)

    server.answer(2, [1, 2, 3, 4])
    await settled
    expect(root.api.f.pages.value).toEqual([[1, 2, 3, 4]])
    root.dispose()
  })

  test('a page request on a force-stale infinite entry is caught up after too', async () => {
    const server = scripted<number[]>({ ignoreAbort: true })
    const feed = defineInfiniteQuery({
      id: 'catch-up/infinite-page',
      key: () => ['feed'],
      fetcher: server.fetcher,
      initialPageParam: 0,
      getNextPageParam: (_last, all) => (all.length < 3 ? all.length : null),
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    server.answer(0, [1])
    await flush()
    const handle = root.bindQuery(feed)

    void handle.invalidate() // call 1: the invalidation's refetch
    void root.api.f.fetchNextPage() // call 2: supersedes it; the entry stays force-stale
    handle.replace([[9]]) // discards the page request, so call 3 catches up
    expect(server.calls).toHaveLength(4)

    server.answer(2, [2]) // the discarded page never lands
    await flush()
    expect(root.api.f.pages.value).toEqual([[9]])

    server.answer(3, [9, 10])
    await vi.waitFor(() => expect(root.api.f.pages.value).toEqual([[9, 10]]))
    expect(root.api.f.isFetching.value).toBe(false)
    root.dispose()
  })

  test('a local cache catches up too', async () => {
    const server = scripted<string>({ ignoreAbort: true })
    const root = createRoot(
      defineController((ctx) => ({ c: createCache(ctx, server.fetcher) })),
      { deps: {} },
    )
    server.answer(0, 'v1')
    await flush()

    const settled = root.api.c.invalidate()
    root.api.c.replace('push')
    expect(server.calls).toHaveLength(3)
    server.answer(1, 'discarded')
    await flush()
    expect(root.api.c.data.value).toBe('push')
    server.answer(2, 'reconciled')
    await settled
    expect(root.api.c.data.value).toBe('reconciled')
    root.dispose()
  })
})
