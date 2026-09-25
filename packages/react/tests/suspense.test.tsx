// @vitest-environment jsdom

import {
  type AsyncState,
  createQuery,
  createRoot,
  defineController,
  defineInfiniteQuery,
  defineQuery,
  queryEngine,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { OlasProvider, useInfiniteQuery, useQuery, useSuspenseQuery } from '../src'

afterEach(() => {
  cleanup()
})

/**
 * Minimal ErrorBoundary fixture — React doesn't ship one. Renders a fallback
 * with the thrown error's message so the test can assert on the textContent.
 */
class ErrorBoundary extends Component<
  { children: ReactNode; fallback: (err: unknown) => ReactNode },
  { err: unknown }
> {
  override state: { err: unknown } = { err: undefined }
  static getDerivedStateFromError(err: unknown): { err: unknown } {
    return { err }
  }
  override componentDidCatch(_err: unknown, _info: ErrorInfo): void {
    // Silence React's act() warning chatter about unhandled errors.
  }
  override render(): ReactNode {
    if (this.state.err !== undefined) return this.props.fallback(this.state.err)
    return this.props.children
  }
}

/**
 * React logs thrown errors caught by ErrorBoundary as `console.error`. Silence
 * for the negative-path tests so the run output stays clean.
 */
function silenceConsoleError(): () => void {
  const prev = console.error
  console.error = () => {}
  return () => {
    console.error = prev
  }
}

describe('useQuery({ suspense: true })', () => {
  test('throws subscription.firstValue() while pending → Suspense fallback shows, then resolves', async () => {
    let resolveFetcher!: (value: string) => void
    const userQuery = defineQuery({
      id: 'suspense-test/load',
      key: () => [],
      fetcher: () =>
        new Promise<string>((resolve) => {
          resolveFetcher = resolve
        }),
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      user: createQuery(ctx, userQuery, () => []),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })

    function UserView() {
      // With suspense: true, `data` is narrowed to T (string).
      const { data } = useQuery(root.api.user, { suspense: true })
      return <span data-testid="user">{data}</span>
    }

    render(
      <OlasProvider root={root}>
        <Suspense fallback={<span data-testid="fallback">loading</span>}>
          <UserView />
        </Suspense>
      </OlasProvider>,
    )

    // Fallback shows while pending.
    expect(screen.getByTestId('fallback').textContent).toBe('loading')

    await act(async () => {
      resolveFetcher('Alice')
      await root.api.user.firstValue()
    })

    // After settle, the actual view renders with data.
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('user').textContent).toBe('Alice')

    root.dispose()
  })

  test('throws subscription.error on error state → caught by ErrorBoundary', async () => {
    const restore = silenceConsoleError()
    try {
      const userQuery = defineQuery({
        id: 'suspense-test/error',
        key: () => [],
        fetcher: async (): Promise<string> => {
          throw new Error('server down')
        },
        retry: 0,
        staleTime: 60_000,
      })

      const def = defineController((ctx) => ({
        user: createQuery(ctx, userQuery, () => []),
      }))
      const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })

      function UserView() {
        const { data } = useQuery(root.api.user, { suspense: true })
        return <span data-testid="user">{data}</span>
      }

      render(
        <OlasProvider root={root}>
          <ErrorBoundary
            fallback={(err) => <span data-testid="err">{(err as Error).message}</span>}
          >
            <Suspense fallback={<span data-testid="fallback">loading</span>}>
              <UserView />
            </Suspense>
          </ErrorBoundary>
        </OlasProvider>,
      )

      await act(async () => {
        await root.api.user.firstValue().catch(() => {})
      })

      // ErrorBoundary catches the throw, Suspense does not.
      expect(screen.queryByTestId('fallback')).toBeNull()
      expect(screen.queryByTestId('user')).toBeNull()
      expect(screen.getByTestId('err').textContent).toBe('server down')

      root.dispose()
    } finally {
      restore()
    }
  })

  test('refetch after first success does NOT re-suspend', async () => {
    let value = 'first'
    const greetingQuery = defineQuery({
      id: 'suspense-test/refetch',
      key: () => [],
      fetcher: async () => value,
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      greeting: createQuery(ctx, greetingQuery, () => []),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })

    function View() {
      const { data } = useQuery(root.api.greeting, { suspense: true })
      return <span data-testid="g">{data}</span>
    }

    render(
      <OlasProvider root={root}>
        <Suspense fallback={<span data-testid="fallback">loading</span>}>
          <View />
        </Suspense>
      </OlasProvider>,
    )

    await act(async () => {
      await root.api.greeting.firstValue()
    })
    expect(screen.getByTestId('g').textContent).toBe('first')

    // Refetch with a new value. `data` stays defined during the refetch, so
    // the hook returns normally — no fallback.
    value = 'second'
    await act(async () => {
      await root.api.greeting.refetch()
    })
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('g').textContent).toBe('second')

    root.dispose()
  })

  // T4.3 — a background-refetch FAILURE keeps the last-good data (applyFailure
  // preserves it), so the suspense hook must not throw the subtree to the
  // ErrorBoundary over a transient blip.
  test('background-refetch failure keeps data, does NOT hit the ErrorBoundary', async () => {
    const restore = silenceConsoleError()
    try {
      let shouldFail = false
      const q = defineQuery({
        id: 'suspense-test/refetch-fail',
        key: () => [],
        fetcher: async (): Promise<string> => {
          if (shouldFail) throw new Error('refetch boom')
          return 'good'
        },
        retry: 0,
        staleTime: 60_000,
      })
      const def = defineController((ctx) => ({ g: createQuery(ctx, q, () => []) }))
      const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })

      function View() {
        const { data } = useQuery(root.api.g, { suspense: true })
        return <span data-testid="g">{data}</span>
      }
      render(
        <OlasProvider root={root}>
          <ErrorBoundary
            fallback={(err) => <span data-testid="err">{(err as Error).message}</span>}
          >
            <Suspense fallback={<span data-testid="fallback">loading</span>}>
              <View />
            </Suspense>
          </ErrorBoundary>
        </OlasProvider>,
      )

      await act(async () => {
        await root.api.g.firstValue()
      })
      expect(screen.getByTestId('g').textContent).toBe('good')

      // Refetch fails: status → 'error' but `data` is kept. The suspense hook
      // must NOT throw (data exists) — the subtree keeps showing the stale value.
      shouldFail = true
      await act(async () => {
        await root.api.g.refetch().catch(() => {})
      })

      expect(screen.queryByTestId('err')).toBeNull()
      expect(screen.getByTestId('g').textContent).toBe('good')

      root.dispose()
    } finally {
      restore()
    }
  })

  // Note (T4.7): a DISABLED query under `{ suspense: true }` suspends forever
  // (idle, no data). Throwing a descriptive error instead was tried but is
  // indistinguishable from a query torn down during dispose (both go idle),
  // which produced teardown false-positives + React-19 uncaughtException noise —
  // so it's a documented limitation in BACKLOG.md, not a hard throw.

  test('without suspense option, hook behaves as before (data: T | undefined)', async () => {
    const greetingQuery = defineQuery({
      id: 'suspense-test/no-suspense',
      key: () => [],
      fetcher: async () => 'hi',
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      greeting: createQuery(ctx, greetingQuery, () => []),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })

    let observed: string | undefined = 'never-set'
    function View() {
      const { data, isLoading } = useQuery(root.api.greeting)
      observed = data
      return <span data-testid="g">{isLoading ? 'L' : (data ?? '-')}</span>
    }

    render(
      <OlasProvider root={root}>
        <View />
      </OlasProvider>,
    )

    // Pre-fetch render: data is undefined (no throw without suspense option).
    expect(observed).toBeUndefined()
    expect(screen.getByTestId('g').textContent).toBe('L')

    await act(async () => {
      await root.api.greeting.firstValue()
    })
    expect(screen.getByTestId('g').textContent).toBe('hi')

    root.dispose()
  })
})

describe('subscription.firstValue()', () => {
  test('resolves with data on success', async () => {
    const q = defineQuery({
      id: 'promise-test/success',
      key: () => [],
      fetcher: async () => ({ id: 1 }),
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ sub: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })

    const value = await root.api.sub.firstValue()
    expect(value).toEqual({ id: 1 })
    root.dispose()
  })

  test('rejects with the error on failure', async () => {
    const boom = new Error('boom')
    const q = defineQuery({
      id: 'promise-test/error',
      key: () => [],
      fetcher: async () => {
        throw boom
      },
      retry: 0,
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ sub: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })

    await expect(root.api.sub.firstValue()).rejects.toBe(boom)
    root.dispose()
  })
})

describe('useQuery({ suspense: true }) on a disabled query', () => {
  test('suspends until the query is enabled and loads, and warns once in development', async () => {
    const warns: unknown[] = []
    const prevWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warns.push(args[0])
    }
    try {
      const enabled = signal(false)
      const q = defineQuery({
        id: 'suspense-test/dependent',
        key: () => [],
        fetcher: async () => 'dependent-data',
      })
      const def = defineController((ctx) => ({
        dep: createQuery(ctx, q, { enabled: () => enabled.value }),
        enable: () => enabled.set(true),
      }))
      const root = createRoot(def, { queries: queryEngine(), deps: {} })

      function View() {
        const { data } = useQuery(root.api.dep, { suspense: true })
        return <span data-testid="dep">{data}</span>
      }

      render(
        <OlasProvider root={root}>
          <Suspense fallback={<span data-testid="fallback">waiting</span>}>
            <View />
          </Suspense>
        </OlasProvider>,
      )
      expect(screen.getByTestId('fallback').textContent).toBe('waiting')
      expect(warns.filter((w) => String(w).includes('disabled query'))).toHaveLength(1)

      await act(async () => {
        root.api.enable()
        await root.api.dep.firstValue()
      })
      expect(screen.getByTestId('dep').textContent).toBe('dependent-data')
      expect(warns.filter((w) => String(w).includes('disabled query'))).toHaveLength(1)
      root.dispose()
    } finally {
      console.warn = prevWarn
    }
  })
})

// A subscription can settle on `undefined`: a `select` that reads an optional
// field, a fetcher that resolves nothing, an infinite query replaced with no
// pages. `firstValue()` resolves at once then, so suspending on
// `data === undefined` alone made React retry, suspend again and retry,
// without end: 2,001 renders, and an event loop starved in the process.
describe('suspense on a subscription that settled on undefined', () => {
  /** More renders than this means the hook re-suspends forever; stop it with an error. */
  const RENDER_CAP = 50

  function mountCapped(
    sub: () => AsyncState<unknown>,
    read = (s: AsyncState<unknown>) => useSuspenseQuery(s).data,
  ) {
    let renders = 0
    function View() {
      renders += 1
      if (renders > RENDER_CAP) throw new Error('re-suspended forever')
      const data = read(sub())
      return (
        <span data-testid="view">{data === undefined ? '(undefined)' : JSON.stringify(data)}</span>
      )
    }
    const restore = silenceConsoleError()
    render(
      <ErrorBoundary
        fallback={(err) => <span data-testid="view">{String((err as Error).message)}</span>}
      >
        <Suspense fallback={<span data-testid="view">loading</span>}>
          <View />
        </Suspense>
      </ErrorBoundary>,
    )
    return { renders: () => renders, restore }
  }

  test('a select that reads a missing optional field renders undefined', async () => {
    type Profile = { name: string; nickname?: string }
    const profile = defineQuery({
      id: 'suspense-test/select-undefined',
      key: () => [],
      fetcher: async (): Promise<Profile> => ({ name: 'Ada' }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({
        nickname: createQuery(ctx, profile, { select: (p: Profile) => p.nickname }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    const view = mountCapped(() => root.api.nickname)
    await act(async () => {
      await root.waitForIdle()
    })
    view.restore()
    expect(screen.getByTestId('view').textContent).toBe('(undefined)')
    expect(view.renders()).toBeLessThan(5)
    root.dispose()
  })

  test('a fetcher that resolves undefined renders, and a refetch does not suspend again', async () => {
    let fetches = 0
    const nothing = defineQuery({
      id: 'suspense-test/fetch-undefined',
      key: () => [],
      fetcher: async (): Promise<string | undefined> => {
        fetches += 1
        return undefined
      },
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ nothing: createQuery(ctx, nothing) })),
      { queries: queryEngine(), deps: {} },
    )
    const view = mountCapped(() => root.api.nothing)
    await act(async () => {
      await root.waitForIdle()
    })
    expect(screen.getByTestId('view').textContent).toBe('(undefined)')
    // A background refetch reads `pending` with no data again; it is not a first load.
    await act(async () => {
      void root.api.nothing.refetch()
      await Promise.resolve()
    })
    expect(screen.getByTestId('view').textContent).toBe('(undefined)')
    await act(async () => {
      await root.waitForIdle()
    })
    view.restore()
    expect(fetches).toBe(2)
    expect(screen.getByTestId('view').textContent).toBe('(undefined)')
    expect(view.renders()).toBeLessThan(8)
    root.dispose()
  })

  test('an infinite query replaced with no pages renders them', async () => {
    const feed = defineInfiniteQuery({
      id: 'suspense-test/infinite-empty',
      key: () => [],
      fetcher: async ({ pageParam }: { pageParam: number }) => [pageParam],
      initialPageParam: 0,
      getNextPageParam: () => null,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ feed: createQuery(ctx, feed) })),
      { queries: queryEngine(), deps: {} },
    )
    await root.waitForIdle()
    feed.replace([])
    const view = mountCapped(
      () => root.api.feed,
      () => useInfiniteQuery(root.api.feed, { suspense: true }).pages,
    )
    await act(async () => {})
    view.restore()
    expect(screen.getByTestId('view').textContent).toBe('[]')
    expect(view.renders()).toBeLessThan(5)
    root.dispose()
  })

  test('a first load still suspends, and a first-load error still reaches the ErrorBoundary', async () => {
    let fail!: (err: Error) => void
    const failing = defineQuery({
      id: 'suspense-test/first-load-error',
      key: () => [],
      fetcher: () =>
        new Promise<string>((_resolve, reject) => {
          fail = reject
        }),
      retry: false,
    })
    const root = createRoot(
      defineController((ctx) => ({ failing: createQuery(ctx, failing) })),
      { queries: queryEngine(), deps: {}, onError: () => {} },
    )
    const view = mountCapped(() => root.api.failing)
    expect(screen.getByTestId('view').textContent).toBe('loading')
    await act(async () => {
      fail(new Error('first load failed'))
      await Promise.resolve()
    })
    view.restore()
    expect(screen.getByTestId('view').textContent).toBe('first load failed')
    root.dispose()
  })
})
