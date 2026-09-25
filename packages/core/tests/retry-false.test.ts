/**
 * `retry: false` means "never retry", as `retry: 0` does (SPEC §5.2).
 *
 * §5.2 allowed it, but `RetryPolicy` had no `false`, and the query retry loops called any
 * non-number as a function: a JS caller passing `false` got "retry is not a function",
 * reported as the fetch's failure in place of the fetch's own error.
 */
import { describe, expect, test } from 'vitest'
import { createMutation, createQuery } from '../src'
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

// `scheduleExpiry` reads a `NaN` delay as "never", as it reads `Infinity`, so a
// `retryDelay` that computed `NaN` left the fetch at `isFetching: true` with no
// retry, until something aborted it. A retry delay of `NaN` means "retry now".
describe('retryDelay: NaN', () => {
  test('a query retries at once instead of waiting forever', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'retry-delay-nan/regular',
      key: () => [],
      fetcher: () => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok')
      },
      retry: 1,
      retryDelay: () => Number.NaN,
    })
    const root = createRoot(
      defineController((ctx) => ({ s: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    await expect(root.api.s.firstValue()).resolves.toBe('ok')
    expect(calls).toBe(2)
    root.dispose()
  })

  test('a mutation retries at once too', async () => {
    let calls = 0
    const root = createRoot(
      defineController((ctx) => ({
        m: createMutation(ctx, {
          mutate: async () => {
            calls += 1
            if (calls === 1) throw new Error('flaky')
            return 'ok'
          },
          retry: 1,
          retryDelay: Number.NaN,
        }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    await expect(root.api.m.run(undefined)).resolves.toBe('ok')
    expect(calls).toBe(2)
    root.dispose()
  })
})
