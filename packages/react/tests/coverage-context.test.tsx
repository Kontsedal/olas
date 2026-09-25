// @vitest-environment jsdom

import {
  type AsyncState,
  createQuery,
  createRoot,
  type DehydratedState,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createOlasContext, HydrationBoundary, STREAMING_GLOBAL, useQuery, useRoot } from '../src'

afterEach(() => {
  cleanup()
  delete (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
  vi.restoreAllMocks()
})

describe('createOlasContext without a display name', () => {
  test('leaves the context unnamed and names <OlasProvider> in the outside-provider error', () => {
    const ctx = createOlasContext<{ n: number }>()
    expect(ctx.Context.displayName).toBeUndefined()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => ctx.useRoot())).toThrow(
      '[olas] useRoot() called outside <OlasProvider>. Make sure the matching Provider wraps the tree.',
    )
  })

  test('inside its provider, useRoot returns that root’s api', () => {
    const ctx = createOlasContext<{ n: number }>()
    const root = createRoot(
      defineController(() => ({ n: 7 })),
      { deps: {} },
    )
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ctx.Provider root={root}>{children}</ctx.Provider>
    )
    const { result } = renderHook(() => ctx.useRoot(), { wrapper })
    expect(result.current.n).toBe(7)
    root.dispose()
  })
})

describe('HydrationBoundary streaming prop', () => {
  const seedBootstrapQueue = (data: string): void => {
    ;(globalThis as Record<string, unknown>)[STREAMING_GLOBAL] = {
      q: [[{ queryId: 'cov-context/streamed', key: [], data, lastUpdatedAt: 1 }]],
      push(b: unknown) {
        ;(this as { q: unknown[] }).q.push(b)
      },
    }
  }
  // The fetch never settles, so the only data the query can hold is streamed data.
  const q = defineQuery({
    id: 'cov-context/streamed',
    key: () => [],
    fetcher: () => new Promise<string>(() => {}),
  })
  const def = defineController((ctx) => ({ v: createQuery(ctx, q) }))
  type Api = { v: AsyncState<string> }

  function View() {
    const { v } = useRoot<Api>()
    const { data } = useQuery(v)
    return <span data-testid="data">{data ?? '(none)'}</span>
  }

  test('streaming={false} leaves the bootstrap queue undrained and unforwarded', () => {
    seedBootstrapQueue('streamed')
    const bootstrap = (globalThis as Record<string, unknown>)[STREAMING_GLOBAL]
    const { unmount } = render(
      <HydrationBoundary def={def} options={{ queries: queryEngine(), deps: {} }} streaming={false}>
        <View />
      </HydrationBoundary>,
    )
    expect(screen.getByTestId('data').textContent).toBe('(none)')
    // The global is still the bootstrap's own object, so a push only queues.
    expect((globalThis as Record<string, unknown>)[STREAMING_GLOBAL]).toBe(bootstrap)
    act(() => {
      ;(bootstrap as { push: (b: unknown) => void }).push([
        { queryId: 'cov-context/streamed', key: [], data: 'late', lastUpdatedAt: 2 },
      ])
    })
    expect(screen.getByTestId('data').textContent).toBe('(none)')
    act(() => unmount())
  })

  test('streamed rows join options.hydrate for the first render', () => {
    seedBootstrapQueue('streamed')
    const other = defineQuery({
      id: 'cov-context/own-hydrate',
      key: () => [],
      fetcher: () => new Promise<string>(() => {}),
    })
    const both = defineController((ctx) => ({
      v: createQuery(ctx, q),
      own: createQuery(ctx, other),
    }))
    function Both() {
      const api = useRoot<Api & { own: AsyncState<string> }>()
      return <span data-testid="data">{`${useQuery(api.v).data}|${useQuery(api.own).data}`}</span>
    }
    const hydrate = {
      version: 1 as const,
      entries: [{ id: 'cov-context/own-hydrate', key: [], data: 'own', lastUpdatedAt: 1 }],
    }
    const { unmount } = render(
      <HydrationBoundary def={both} options={{ queries: queryEngine(), deps: {}, hydrate }}>
        <Both />
      </HydrationBoundary>,
    )
    expect(screen.getByTestId('data').textContent).toBe('streamed|own')
    act(() => unmount())
  })

  test('beside a hydrate payload of another version, the streamed rows arrive through the intake', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seedBootstrapQueue('streamed')
    const hydrate = { version: 2, entries: [] } as unknown as DehydratedState
    const { unmount } = render(
      <HydrationBoundary def={def} options={{ queries: queryEngine(), deps: {}, hydrate }}>
        <View />
      </HydrationBoundary>,
    )
    expect(warn.mock.calls.some((c) => /unsupported state\.version/.test(String(c[0])))).toBe(true)
    expect(screen.getByTestId('data').textContent).toBe('streamed')
    act(() => unmount())
  })

  test('by default the boundary drains the queue into its root', () => {
    seedBootstrapQueue('streamed')
    const { unmount } = render(
      <HydrationBoundary def={def} options={{ queries: queryEngine(), deps: {} }}>
        <View />
      </HydrationBoundary>,
    )
    expect(screen.getByTestId('data').textContent).toBe('streamed')
    act(() => unmount())
  })
})
