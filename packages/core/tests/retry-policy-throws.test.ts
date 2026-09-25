/**
 * A `retry` or `retryDelay` callback that throws fails the attempt with its own error,
 * through the normal failure path. It used to escape the retry loop: the fetch promise
 * rejected with `isFetching` still true, so the spinner, `waitForIdle()` and
 * `firstValue()` hung with nothing to clear them.
 *
 * Also here: the `attempt` and `cause` an invalidation's failure reports to `onError`.
 */
import { describe, expect, test, vi } from 'vitest'
import { createMutation, createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import type { ErrorContext } from '../src/errors'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('a throwing retry policy settles the fetch as failed', () => {
  test('the reviewer reproduction: retry() throws on a regular query', async () => {
    const policyBug = new Error('retry policy bug')
    const q = defineQuery({
      id: 'retry-throws/regular',
      key: () => ['k'],
      fetcher: () => Promise.reject(new Error('fetch failed')),
      retry: () => {
        throw policyBug
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const s = root.api.s
    expect(s.status.value).toBe('error')
    expect(s.error.value).toBe(policyBug)
    expect(s.isFetching.value).toBe(false)
    expect(s.isLoading.value).toBe(false)
    await expect(s.firstValue()).rejects.toBe(policyBug)
    root.dispose()
  })

  test('a throwing retryDelay settles the same way, after the policy said retry', async () => {
    const delayBug = new Error('retryDelay bug')
    let calls = 0
    const q = defineQuery({
      id: 'retry-throws/delay',
      key: () => ['k'],
      fetcher: () => {
        calls += 1
        return Promise.reject(new Error('fetch failed'))
      },
      retry: 3,
      retryDelay: () => {
        throw delayBug
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    expect(root.api.s.error.value).toBe(delayBug)
    expect(root.api.s.isFetching.value).toBe(false)
    expect(calls).toBe(1)
    root.dispose()
  })

  test('an infinite query first load settles when retry() throws', async () => {
    const policyBug = new Error('retry policy bug')
    const feed = defineInfiniteQuery({
      id: 'retry-throws/infinite',
      key: () => ['feed'],
      fetcher: () => Promise.reject(new Error('fetch failed')),
      initialPageParam: 0,
      getNextPageParam: () => null,
      retry: () => {
        throw policyBug
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    const f = root.api.f
    expect(f.status.value).toBe('error')
    expect(f.error.value).toBe(policyBug)
    expect(f.isFetching.value).toBe(false)
    expect(f.isLoading.value).toBe(false)
    root.dispose()
  })

  test('an infinite page request settles, flags and pages included, when retry() throws', async () => {
    const policyBug = new Error('retry policy bug')
    let failPages = false
    const feed = defineInfiniteQuery({
      id: 'retry-throws/infinite-next',
      key: () => ['feed'],
      fetcher: ({ pageParam }) =>
        failPages ? Promise.reject(new Error('page failed')) : Promise.resolve([pageParam]),
      initialPageParam: 0,
      getNextPageParam: (last: number[]) => (last[0] as number) + 1,
      getPreviousPageParam: (first: number[]) => (first[0] as number) - 1,
      retry: (attempt) => {
        if (failPages) throw policyBug
        return attempt < 1
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    failPages = true
    const f = root.api.f

    await f.fetchNextPage().catch(() => {})
    expect(f.error.value).toBe(policyBug)
    expect(f.isFetchingNextPage.value).toBe(false)
    expect(f.isFetching.value).toBe(false)
    expect(f.pages.value).toEqual([[0]])

    await f.fetchPreviousPage().catch(() => {})
    expect(f.isFetchingPreviousPage.value).toBe(false)
    expect(f.isFetching.value).toBe(false)
    await root.waitForIdle()
    root.dispose()
  })

  test('an infinite page request settles when retryDelay throws', async () => {
    const delayBug = new Error('retryDelay bug')
    let failPages = false
    const feed = defineInfiniteQuery({
      id: 'retry-throws/infinite-delay',
      key: () => ['feed'],
      fetcher: ({ pageParam }) =>
        failPages ? Promise.reject(new Error('page failed')) : Promise.resolve([pageParam]),
      initialPageParam: 0,
      getNextPageParam: (last: number[]) => (last[0] as number) + 1,
      retry: 2,
      retryDelay: () => {
        if (failPages) throw delayBug
        return 0
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    failPages = true
    await root.api.f.fetchNextPage().catch(() => {})
    expect(root.api.f.error.value).toBe(delayBug)
    expect(root.api.f.isFetchingNextPage.value).toBe(false)
    expect(root.api.f.isFetching.value).toBe(false)
    root.dispose()
  })

  test('a mutation run fails with the callback error and does not wedge', async () => {
    // The mutation runner never wedged: the throw rejects `runWithRetry`, and the run's
    // own catch settles it. Pinned so it stays that way.
    const policyBug = new Error('retry policy bug')
    const root = createRoot(
      defineController((ctx) => ({
        save: createMutation(ctx, {
          mutate: () => Promise.reject(new Error('write failed')),
          retry: () => {
            throw policyBug
          },
        }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    await expect(root.api.save.run(undefined)).rejects.toBe(policyBug)
    expect(root.api.save.error.value).toBe(policyBug)
    expect(root.api.save.isPending.value).toBe(false)
    await root.waitForIdle()
    root.dispose()
  })
})

describe('ErrorContext.attempt and cause on an invalidation failure', () => {
  const record = (): {
    onError: (err: unknown, ctx: ErrorContext) => void
    seen: ErrorContext[]
  } => {
    const seen: ErrorContext[] = []
    return { seen, onError: (_err, ctx) => seen.push(ctx) }
  }

  test('attempt is the 0-based attempt that failed last', async () => {
    const { onError, seen } = record()
    let fail = false
    const q = defineQuery({
      id: 'error-context/attempt',
      key: () => ['k'],
      fetcher: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve('v')),
      retry: 2,
      retryDelay: 0,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, onError },
    )
    await root.waitForIdle()
    fail = true
    await root.bindQuery(q).invalidate()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'cache', queryId: 'error-context/attempt', attempt: 2 })
    expect(seen[0]).not.toHaveProperty('cause')
    root.dispose()
  })

  test('a throwing retry callback reports the fetch error as the cause', async () => {
    const { onError, seen } = record()
    const policyBug = new Error('retry policy bug')
    const fetchErr = new Error('down')
    let fail = false
    const q = defineQuery({
      id: 'error-context/cause',
      key: () => ['k'],
      fetcher: () => (fail ? Promise.reject(fetchErr) : Promise.resolve('v')),
      retry: () => {
        throw policyBug
      },
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {}, onError },
    )
    await root.waitForIdle()
    fail = true
    await root.bindQuery(q).invalidate()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'cache', attempt: 0, cause: fetchErr })
    root.dispose()
  })

  test('an infinite query reports them too', async () => {
    const onError = vi.fn()
    const policyBug = new Error('retry policy bug')
    const fetchErr = new Error('down')
    let fail = false
    const feed = defineInfiniteQuery({
      id: 'error-context/infinite',
      key: () => ['feed'],
      fetcher: () => (fail ? Promise.reject(fetchErr) : Promise.resolve([1])),
      initialPageParam: 0,
      getNextPageParam: () => null,
      retry: (attempt) => {
        if (attempt >= 1) throw policyBug
        return true
      },
      retryDelay: 0,
    })
    const root = createRoot(
      defineController((ctx) => ({ f: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {}, onError },
    )
    await root.waitForIdle()
    fail = true
    await root.bindQuery(feed).invalidate()
    await flush()
    expect(onError).toHaveBeenCalledWith(
      policyBug,
      expect.objectContaining({ kind: 'cache', attempt: 1, cause: fetchErr }),
    )
    root.dispose()
  })
})
