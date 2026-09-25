/**
 * `retry: false` means "never retry", as `retry: 0` does (SPEC §5.2).
 *
 * §5.2 allowed it, but `RetryPolicy` had no `false`, and the query retry loops called any
 * non-number as a function: a JS caller passing `false` got "retry is not a function",
 * reported as the fetch's failure in place of the fetch's own error.
 */
import { describe, expect, test } from 'vitest'
import { createQuery } from '../src'
import { createRoot, defineController } from '../src/controller'
import { defineInfiniteQuery, defineQuery } from '../src/query/define'
import { queryEngine } from '../src/query/engine'

describe('retry: false', () => {
  test('a query fails with the fetch error after one attempt', async () => {
    const failure = new Error('fetch failed')
    let calls = 0
    const q = defineQuery({
      id: 'retry-false/regular',
      key: () => [],
      fetcher: () => {
        calls += 1
        return Promise.reject(failure)
      },
      retry: false,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    expect(root.api.s.status.value).toBe('error')
    expect(root.api.s.error.value).toBe(failure)
    expect(calls).toBe(1)
    root.dispose()
  })

  test('an infinite query fails with the fetch error after one attempt', async () => {
    const failure = new Error('page failed')
    let calls = 0
    const q = defineInfiniteQuery({
      id: 'retry-false/infinite',
      key: () => [],
      fetcher: () => {
        calls += 1
        return Promise.reject(failure)
      },
      initialPageParam: 0,
      getNextPageParam: () => null,
      retry: false,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    expect(root.api.s.status.value).toBe('error')
    expect(root.api.s.error.value).toBe(failure)
    expect(calls).toBe(1)
    root.dispose()
  })

  test('a root default of false applies too', async () => {
    const failure = new Error('fetch failed')
    const q = defineQuery({
      id: 'retry-false/default',
      key: () => [],
      fetcher: () => Promise.reject(failure),
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine({ defaults: { retry: false } }), deps: {} },
    )
    await root.waitForIdle()
    expect(root.api.s.error.value).toBe(failure)
    root.dispose()
  })
})
