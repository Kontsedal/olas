// @vitest-environment jsdom

import { createRoot, defineController, defineQuery } from '@kontsedal/olas-core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Component, type ErrorInfo, type ReactNode, Suspense } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { OlasProvider, useQuery } from '../src'

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
  test('throws subscription.promise() while pending → Suspense fallback shows, then resolves', async () => {
    let resolveFetcher!: (value: string) => void
    const userQuery = defineQuery({
      queryId: 'suspense-test/load',
      key: () => [],
      fetcher: () =>
        new Promise<string>((resolve) => {
          resolveFetcher = resolve
        }),
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      user: ctx.use(userQuery, () => []),
    }))
    const root = createRoot(def, { deps: {} })

    function UserView() {
      // With suspense: true, `data` is narrowed to T (string).
      const { data } = useQuery(root.user, { suspense: true })
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
      await root.user.firstValue()
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
        queryId: 'suspense-test/error',
        key: () => [],
        fetcher: async (): Promise<string> => {
          throw new Error('server down')
        },
        retry: 0,
        staleTime: 60_000,
      })

      const def = defineController((ctx) => ({
        user: ctx.use(userQuery, () => []),
      }))
      const root = createRoot(def, { deps: {}, onError: () => {} })

      function UserView() {
        const { data } = useQuery(root.user, { suspense: true })
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
        await root.user.firstValue().catch(() => {})
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
      queryId: 'suspense-test/refetch',
      key: () => [],
      fetcher: async () => value,
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      greeting: ctx.use(greetingQuery, () => []),
    }))
    const root = createRoot(def, { deps: {} })

    function View() {
      const { data } = useQuery(root.greeting, { suspense: true })
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
      await root.greeting.firstValue()
    })
    expect(screen.getByTestId('g').textContent).toBe('first')

    // Refetch with a new value. `data` stays defined during the refetch, so
    // the hook returns normally — no fallback.
    value = 'second'
    await act(async () => {
      await root.greeting.refetch()
    })
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('g').textContent).toBe('second')

    root.dispose()
  })

  test('without suspense option, hook behaves as before (data: T | undefined)', async () => {
    const greetingQuery = defineQuery({
      queryId: 'suspense-test/no-suspense',
      key: () => [],
      fetcher: async () => 'hi',
      staleTime: 60_000,
    })

    const def = defineController((ctx) => ({
      greeting: ctx.use(greetingQuery, () => []),
    }))
    const root = createRoot(def, { deps: {} })

    let observed: string | undefined = 'never-set'
    function View() {
      const { data, isLoading } = useQuery(root.greeting)
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
      await root.greeting.firstValue()
    })
    expect(screen.getByTestId('g').textContent).toBe('hi')

    root.dispose()
  })
})

describe('subscription.promise()', () => {
  test('resolves with data on success', async () => {
    const q = defineQuery({
      queryId: 'promise-test/success',
      key: () => [],
      fetcher: async () => ({ id: 1 }),
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ sub: ctx.use(q, () => []) }))
    const root = createRoot(def, { deps: {} })

    const value = await root.sub.promise()
    expect(value).toEqual({ id: 1 })
    root.dispose()
  })

  test('rejects with the error on failure', async () => {
    const boom = new Error('boom')
    const q = defineQuery({
      queryId: 'promise-test/error',
      key: () => [],
      fetcher: async () => {
        throw boom
      },
      retry: 0,
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ sub: ctx.use(q, () => []) }))
    const root = createRoot(def, { deps: {}, onError: () => {} })

    await expect(root.sub.promise()).rejects.toBe(boom)
    root.dispose()
  })
})
