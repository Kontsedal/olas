/**
 * A prefetch settles with the fetch it started or joined, and lets go of the entry
 * when it does (SPEC §5.7).
 *
 * `prefetch` holds the entry while it waits, so the entry is not gc'd mid-flight. It used
 * to fall back to `firstValue()` on an abort, which settles only on a success or an error.
 * A `cancel()` on an entry without data leaves it `idle`, so the promise never settled,
 * the hold was never released, the entry was never gc'd, and `invalidate` kept
 * refetching it as if subscribed. `prefetchInfinite` neither joined a fetch in flight nor
 * turned a supersede into the eventual result.
 */
import { describe, expect, test } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'
import { isAbortError } from '../src/utils'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const deferred = <T>() => {
  let resolve: (v: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A fetcher answering each call from its own deferred, rejecting on abort. */
function scripted<T>() {
  const calls: Array<ReturnType<typeof deferred<T>>> = []
  return {
    calls,
    fetcher: ({ signal }: { signal: AbortSignal }): Promise<T> => {
      const d = deferred<T>()
      calls.push(d)
      return new Promise<T>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        d.promise.then(resolve)
      })
    },
  }
}

const emptyRoot = () =>
  createRoot(
    defineController(() => ({})),
    { queries: queryEngine(), deps: {} },
  )

describe('prefetch settles when its fetch is cancelled', () => {
  test('the reviewer reproduction: it rejects with an AbortError and lets go of the entry', async () => {
    const server = scripted<string>()
    const q = defineQuery({
      id: 'prefetch-settles/cancel',
      key: () => ['k'],
      fetcher: server.fetcher,
      gcTime: 0,
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    const settled = handle.prefetch().then(
      () => 'resolved',
      (err: unknown) => (isAbortError(err) ? 'aborted' : 'rejected'),
    )
    await flush()
    handle.cancel()
    expect(await settled).toBe('aborted')
    await flush()
    // The hold is released, so `gcTime: 0` drops the entry.
    expect(root.debug.queryEntries()).toHaveLength(0)
    root.dispose()
  })

  test('an invalidate after the cancel does not refetch a subscriber-less entry', async () => {
    const server = scripted<string>()
    const q = defineQuery({
      id: 'prefetch-settles/cancel-invalidate',
      key: () => ['k'],
      fetcher: server.fetcher,
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    const settled = handle.prefetch().catch(() => {})
    await flush()
    handle.cancel()
    await settled
    await handle.invalidate()
    expect(server.calls).toHaveLength(1)
    root.dispose()
  })

  test('a prefetch that joined a fetch in flight settles on the cancel too', async () => {
    const server = scripted<string>()
    const q = defineQuery({
      id: 'prefetch-settles/join-cancel',
      key: () => ['k'],
      fetcher: server.fetcher,
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    const first = handle.prefetch().catch((err: unknown) => err)
    const joined = handle.prefetch().catch((err: unknown) => err)
    await flush()
    expect(server.calls).toHaveLength(1)
    handle.cancel()
    expect(isAbortError(await first)).toBe(true)
    expect(isAbortError(await joined)).toBe(true)
    root.dispose()
  })

  test('a cancel over data resolves the prefetch with that data', async () => {
    const server = scripted<string>()
    const q = defineQuery({
      id: 'prefetch-settles/cancel-with-data',
      key: () => ['k'],
      fetcher: server.fetcher,
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    handle.write(() => 'cached')
    const settled = handle.prefetch()
    await flush()
    handle.cancel()
    await expect(settled).resolves.toBe('cached')
    root.dispose()
  })

  test('a joining prefetch waits for the refetch in flight, not the stale data', async () => {
    const server = scripted<string>()
    const q = defineQuery({
      id: 'prefetch-settles/join-refetch',
      key: () => ['k'],
      fetcher: server.fetcher,
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    handle.write(() => 'stale')
    const first = handle.prefetch()
    const joined = handle.prefetch()
    await flush()
    server.calls[0]?.resolve('fresh')
    await expect(first).resolves.toBe('fresh')
    await expect(joined).resolves.toBe('fresh')
    root.dispose()
  })
})

describe('prefetchInfinite mirrors prefetch', () => {
  const pagesQuery = (id: string, fetcher: (ctx: { signal: AbortSignal }) => Promise<string>) =>
    defineInfiniteQuery({
      id,
      key: () => ['k'],
      fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
    })

  test('it joins a fetch in flight instead of restarting it', async () => {
    const server = scripted<string>()
    const q = pagesQuery('prefetch-settles/infinite-join', server.fetcher)
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    expect(server.calls).toHaveLength(1)
    const prefetched = root.bindQuery(q).prefetch()
    await flush()
    expect(server.calls).toHaveLength(1)
    server.calls[0]?.resolve('page 0')
    await expect(prefetched).resolves.toBe('page 0')
    root.dispose()
  })

  test('a supersede resolves it with the eventual result, not a rejection', async () => {
    const server = scripted<string>()
    const q = pagesQuery('prefetch-settles/infinite-supersede', server.fetcher)
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    const prefetched = handle.prefetch()
    await flush()
    // A second refetch supersedes the prefetch's own.
    const again = handle.invalidate()
    await flush()
    expect(server.calls).toHaveLength(2)
    server.calls[1]?.resolve('page 0, fresh')
    await expect(prefetched).resolves.toBe('page 0, fresh')
    await again
    root.dispose()
  })

  test('a cancel settles it with an AbortError and lets go of the entry', async () => {
    const server = scripted<string>()
    const q = defineInfiniteQuery({
      id: 'prefetch-settles/infinite-cancel',
      key: () => ['k'],
      fetcher: server.fetcher,
      initialPageParam: 0,
      getNextPageParam: () => null,
      gcTime: 0,
    })
    const root = emptyRoot()
    const handle = root.bindQuery(q)
    const settled = handle.prefetch().catch((err: unknown) => err)
    await flush()
    handle.cancel()
    expect(isAbortError(await settled)).toBe(true)
    await flush()
    expect(root.debug.queryEntries()).toHaveLength(0)
    root.dispose()
  })
})
