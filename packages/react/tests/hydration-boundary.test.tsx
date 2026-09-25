// @vitest-environment jsdom

import {
  createQuery,
  defineController,
  defineQuery,
  queryEngine,
  type ReadSignal,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, Suspense, startTransition, useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { HydrationBoundary, useRoot, useSuspenseQuery, useValue } from '../src'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// R4.1 (T4.1) — HydrationBoundary must NOT build the root in useMemo (side-
// effectful; StrictMode double-invokes it → orphaned live root). It must own
// the root with ref+effect lifecycle: dispose on unmount, read `options` once,
// recreate only on `def` identity change.
describe('HydrationBoundary lifecycle (R4.1)', () => {
  test('(a) unmount disposes the root', () => {
    const warn = vi.spyOn(console, 'warn')
    const disposed = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(disposed)
      return { label: 'x' }
    })
    const { unmount } = render(
      <HydrationBoundary def={def} options={{ deps: {} }}>
        <div />
      </HydrationBoundary>,
    )
    expect(disposed).not.toHaveBeenCalled()
    act(() => unmount())
    expect(disposed).toHaveBeenCalledTimes(1)
    // In the browser the effect cleanup owns disposal, so the server-render
    // warning stays quiet.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  test('(b) StrictMode mount leaves exactly one live root', () => {
    const constructs = vi.fn()
    const disposes = vi.fn()
    const def = defineController((ctx) => {
      constructs()
      ctx.onDispose(disposes)
      return { label: 'ok' }
    })
    function Show() {
      const api = useRoot<{ label: string }>()
      return <span data-testid="l">{api.label}</span>
    }
    const { getByTestId } = render(
      <StrictMode>
        <HydrationBoundary def={def} options={{ deps: {} }}>
          <Show />
        </HydrationBoundary>
      </StrictMode>,
    )
    // Exactly one live root remains and it's wired to the Provider.
    expect(constructs.mock.calls.length - disposes.mock.calls.length).toBe(1)
    expect(getByTestId('l').textContent).toBe('ok')
  })

  test('(b2) StrictMode with a query engine and a hydrate payload', async () => {
    // The remount rebuilds the root from the same options object, and with it
    // the same `queryEngine()` value. An engine that could be adopted only once
    // made this throw in every StrictMode app that hydrated.
    const fetcher = vi.fn(async () => 'fetched')
    const greeting = defineQuery({
      id: 'hydration-boundary/greeting',
      key: () => [],
      fetcher,
      staleTime: 60_000,
    })
    const def = defineController((ctx) => ({ greeting: createQuery(ctx, greeting) }))
    function Show() {
      const api = useRoot<{ greeting: { data: { value: string | undefined } } }>()
      return <span data-testid="g">{api.greeting.data.value}</span>
    }
    const hydrate = {
      version: 1 as const,
      entries: [
        { id: 'hydration-boundary/greeting', key: [], data: 'hydrated', lastUpdatedAt: Date.now() },
      ],
    }
    const { getByTestId } = render(
      <StrictMode>
        <HydrationBoundary def={def} options={{ deps: {}, queries: queryEngine(), hydrate }}>
          <Show />
        </HydrationBoundary>
      </StrictMode>,
    )
    expect(getByTestId('g').textContent).toBe('hydrated')
    expect(fetcher).not.toHaveBeenCalled()
  })

  test('(c) parent re-render with inline options does not recreate the root', () => {
    const constructs = vi.fn()
    const def = defineController(() => {
      constructs()
      return { label: 'x' }
    })
    function Parent({ tick }: { tick: number }) {
      // Inline options literal → new object identity on every render.
      return (
        <HydrationBoundary def={def} options={{ deps: { tick } }}>
          <div />
        </HydrationBoundary>
      )
    }
    const { rerender } = render(<Parent tick={0} />)
    const afterMount = constructs.mock.calls.length
    rerender(<Parent tick={1} />)
    rerender(<Parent tick={2} />)
    expect(constructs.mock.calls.length).toBe(afterMount)
  })

  test('(d) def identity change disposes the old root and creates a new one', () => {
    const constructsA = vi.fn()
    const disposesA = vi.fn()
    const constructsB = vi.fn()
    const defA = defineController((ctx) => {
      constructsA()
      ctx.onDispose(disposesA)
      return { label: 'A' }
    })
    const defB = defineController(() => {
      constructsB()
      return { label: 'B' }
    })
    function Parent({ which }: { which: typeof defA }) {
      return (
        <HydrationBoundary def={which} options={{ deps: {} }}>
          <div />
        </HydrationBoundary>
      )
    }
    const { rerender } = render(<Parent which={defA} />)
    expect(constructsA).toHaveBeenCalledTimes(1)
    act(() => rerender(<Parent which={defB} />))
    expect(disposesA).toHaveBeenCalledTimes(1)
    expect(constructsB).toHaveBeenCalledTimes(1)
  })

  test('(e) the root rebuilt for a new def does not re-apply the first hydrate payload', async () => {
    const fetcher = vi.fn(async () => 'fresh')
    const greeting = defineQuery({
      id: 'hydration-boundary/rehydrate',
      key: () => [],
      fetcher,
      staleTime: 60_000,
    })
    const defA = defineController((ctx) => ({ greeting: createQuery(ctx, greeting) }))
    const defB = defineController((ctx) => ({ greeting: createQuery(ctx, greeting) }))
    const hydrate = {
      version: 1 as const,
      entries: [
        { id: 'hydration-boundary/rehydrate', key: [], data: 'server', lastUpdatedAt: Date.now() },
      ],
    }
    function Show() {
      const api = useRoot<{ greeting: { data: ReadSignal<string | undefined> } }>()
      return <span data-testid="g">{useValue(api.greeting.data) ?? 'none'}</span>
    }
    const options = { deps: {}, queries: queryEngine(), hydrate }
    function Parent({ which }: { which: typeof defA }) {
      return (
        <HydrationBoundary def={which} options={options}>
          <Show />
        </HydrationBoundary>
      )
    }
    const { rerender, getByTestId } = render(<Parent which={defA} />)
    expect(getByTestId('g').textContent).toBe('server')
    expect(fetcher).not.toHaveBeenCalled()
    await act(async () => {
      rerender(<Parent which={defB} />)
      await Promise.resolve()
    })
    // The new root fetched for itself instead of adopting the stale payload.
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(getByTestId('g').textContent).toBe('fresh'))
  })
})

// A child that suspends or throws before the boundary's first commit makes
// React discard the render, and no effect of the boundary runs. The root that
// render built used to stay alive forever, and every retry built another.
describe('HydrationBoundary renders that never commit', () => {
  const GRACE_MS = 10_000

  function trackedDef() {
    const constructs = vi.fn()
    const disposes = vi.fn()
    const effectRuns = vi.fn()
    const tick = signal(0)
    const def = defineController((ctx) => {
      constructs()
      ctx.onDispose(disposes)
      ctx.effect(() => {
        tick.value
        effectRuns()
      })
      return { label: 'x' }
    })
    const live = () => constructs.mock.calls.length - disposes.mock.calls.length
    return { def, constructs, disposes, effectRuns, tick, live }
  }

  test('(f) unmounting while suspended disposes the uncommitted root once idle', async () => {
    vi.useFakeTimers()
    const { def, constructs, effectRuns, tick, live } = trackedDef()
    const never = new Promise<void>(() => {})
    function Suspender(): null {
      throw never
    }
    const { unmount } = render(
      <Suspense fallback={<span>loading</span>}>
        <HydrationBoundary def={def} options={{ deps: {} }}>
          <Suspender />
        </HydrationBoundary>
      </Suspense>,
    )
    await act(async () => {})
    // React 19 re-renders the suspended tree once more to prerender it. The
    // second attempt reuses the first attempt's root.
    expect(constructs).toHaveBeenCalledTimes(1)
    act(() => unmount())
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS))
    expect(live()).toBe(0)
    const runs = effectRuns.mock.calls.length
    tick.value++
    expect(effectRuns).toHaveBeenCalledTimes(runs)
  })

  test('(g) a retry after the child resolves commits the same root', async () => {
    vi.useFakeTimers()
    const { def, constructs, disposes, live } = trackedDef()
    let done = false
    let resolve!: () => void
    const gate = new Promise<void>((r) => {
      resolve = () => {
        done = true
        r()
      }
    })
    function Child() {
      const api = useRoot<{ label: string }>()
      if (!done) throw gate
      return <span data-testid="l">{api.label}</span>
    }
    const { getByTestId, unmount } = render(
      <Suspense fallback={<span>loading</span>}>
        <HydrationBoundary def={def} options={{ deps: {} }}>
          <Child />
        </HydrationBoundary>
      </Suspense>,
    )
    await act(async () => {
      resolve()
      await gate
    })
    expect(getByTestId('l').textContent).toBe('x')
    expect(constructs).toHaveBeenCalledTimes(1)
    // The sweep leaves a committed root alone.
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS * 2))
    expect(disposes).not.toHaveBeenCalled()
    act(() => unmount())
    expect(live()).toBe(0)
  })

  test('(h) useSuspenseQuery under a Suspense above the boundary loads once', async () => {
    const fetcher = vi.fn(async () => 'loaded')
    const greeting = defineQuery({
      id: 'hydration-boundary/suspense-above',
      key: () => [],
      fetcher,
    })
    const constructs = vi.fn()
    const def = defineController((ctx) => {
      constructs()
      return { greeting: createQuery(ctx, greeting) }
    })
    function Show() {
      const api = useRoot<{ greeting: Parameters<typeof useSuspenseQuery<string>>[0] }>()
      return <span data-testid="g">{useSuspenseQuery(api.greeting).data}</span>
    }
    const { findByTestId } = render(
      <Suspense fallback={<span>loading</span>}>
        <HydrationBoundary def={def} options={{ deps: {}, queries: queryEngine() }}>
          <Show />
        </HydrationBoundary>
      </Suspense>,
    )
    // Each retry used to build a root that refetched and suspended again.
    expect((await findByTestId('g')).textContent).toBe('loaded')
    expect(constructs).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('(i) a root whose fetch outlasts the grace period is not swept under its child', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(
      () => new Promise<string>((r) => setTimeout(() => r('slow'), GRACE_MS * 2)),
    )
    const greeting = defineQuery({ id: 'hydration-boundary/slow', key: () => [], fetcher })
    const disposes = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(disposes)
      return { greeting: createQuery(ctx, greeting) }
    })
    function Show() {
      const api = useRoot<{ greeting: Parameters<typeof useSuspenseQuery<string>>[0] }>()
      return <span data-testid="g">{useSuspenseQuery(api.greeting).data}</span>
    }
    const { getByTestId } = render(
      <Suspense fallback={<span>loading</span>}>
        <HydrationBoundary def={def} options={{ deps: {}, queries: queryEngine() }}>
          <Show />
        </HydrationBoundary>
      </Suspense>,
    )
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS * 2))
    expect(getByTestId('g').textContent).toBe('slow')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(disposes).not.toHaveBeenCalled()
  })

  test('(j) a new def whose render is thrown away leaves the committed root alive', async () => {
    vi.useFakeTimers()
    const a = trackedDef()
    const b = trackedDef()
    const never = new Promise<void>(() => {})
    function Show({ which }: { which: unknown }) {
      if (which === b.def) throw never
      return <span data-testid="l">{useRoot<{ label: string }>().label}</span>
    }
    let setWhich!: (def: typeof a.def) => void
    function Parent() {
      const [which, set] = useState(a.def)
      setWhich = set
      return (
        <Suspense fallback={<span>loading</span>}>
          <HydrationBoundary def={which} options={{ deps: {} }}>
            <Show which={which} />
          </HydrationBoundary>
        </Suspense>
      )
    }
    const { getByTestId } = render(<Parent />)
    await act(async () => {
      startTransition(() => setWhich(b.def))
    })
    // The transition is still pending, so the committed tree still reads A.
    expect(getByTestId('l').textContent).toBe('x')
    expect(a.disposes).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS))
    // B's roots never committed; the sweep took them. A is untouched.
    expect(b.live()).toBe(0)
    expect(a.live()).toBe(1)
  })

  test('(l) a Suspense above that hides the committed boundary keeps its root', async () => {
    const { def, constructs, disposes } = trackedDef()
    const gate = signal(false)
    let release!: () => void
    const pending = new Promise<void>((r) => {
      release = r
    })
    let settled = false
    void pending.then(() => {
      settled = true
    })
    function Child() {
      const api = useRoot<{ label: string }>()
      // A store-driven update is synchronous, so React cannot keep the old
      // content on screen: it hides it behind the fallback, and runs the
      // layout-effect cleanups of the hidden tree.
      if (useValue(gate) && !settled) throw pending
      return <span data-testid="l">{api.label}</span>
    }
    const { findByTestId } = render(
      <Suspense fallback={<span>loading</span>}>
        <HydrationBoundary def={def} options={{ deps: {} }}>
          <Child />
        </HydrationBoundary>
      </Suspense>,
    )
    await findByTestId('l')
    await act(async () => {
      gate.set(true)
    })
    expect(disposes).not.toHaveBeenCalled()
    await act(async () => {
      release()
      await pending
    })
    expect((await findByTestId('l')).textContent).toBe('x')
    expect(constructs).toHaveBeenCalledTimes(1)
    expect(disposes).not.toHaveBeenCalled()
  })

  test('(m) an unclaimed root that never goes idle is disposed after a minute', async () => {
    vi.useFakeTimers()
    const greeting = defineQuery({
      id: 'hydration-boundary/hung',
      key: () => [],
      fetcher: () => new Promise<string>(() => {}),
    })
    const disposes = vi.fn()
    const def = defineController((ctx) => {
      ctx.onDispose(disposes)
      return { greeting: createQuery(ctx, greeting) }
    })
    function Show() {
      const api = useRoot<{ greeting: Parameters<typeof useSuspenseQuery<string>>[0] }>()
      return <span>{useSuspenseQuery(api.greeting).data}</span>
    }
    const { unmount } = render(
      <Suspense fallback={<span>loading</span>}>
        <HydrationBoundary def={def} options={{ deps: {}, queries: queryEngine() }}>
          <Show />
        </HydrationBoundary>
      </Suspense>,
    )
    await act(async () => {})
    act(() => unmount())
    // The hung fetch keeps `waitForIdle` pending, so the idle countdown never starts.
    await act(() => vi.advanceTimersByTimeAsync(GRACE_MS * 3))
    expect(disposes).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(disposes).toHaveBeenCalledTimes(1)
  })

  test('(n) a parent that re-creates the boundary below an outer Suspense loads once', async () => {
    const fetcher = vi.fn(async () => 'loaded')
    const greeting = defineQuery({ id: 'hydration-boundary/re-created', key: () => [], fetcher })
    const constructs = vi.fn()
    const def = defineController((ctx) => {
      constructs()
      return { greeting: createQuery(ctx, greeting) }
    })
    const api = { name: 'service' }
    function Show() {
      const root = useRoot<{ greeting: Parameters<typeof useSuspenseQuery<string>>[0] }>()
      return <span data-testid="g">{useSuspenseQuery(root.greeting).data}</span>
    }
    // App renders a new element, with new inline options, on every attempt.
    function App() {
      return (
        <HydrationBoundary def={def} options={{ deps: { api }, queries: queryEngine() }}>
          <Show />
        </HydrationBoundary>
      )
    }
    const { findByTestId } = render(
      <Suspense fallback={<span>loading</span>}>
        <App />
      </Suspense>,
    )
    expect((await findByTestId('g')).textContent).toBe('loaded')
    expect(constructs).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  test('(o) two boundaries that share a def and options get two roots', () => {
    let n = 0
    const def = defineController(() => ({ id: ++n }))
    function Show() {
      return <span>{useRoot<{ id: number }>().id}</span>
    }
    const options = { deps: {} }
    const { container } = render(
      <>
        <HydrationBoundary def={def} options={options}>
          <Show />
        </HydrationBoundary>
        <HydrationBoundary def={def} options={options}>
          <Show />
        </HydrationBoundary>
      </>,
    )
    const ids = [...container.querySelectorAll('span')].map((s) => s.textContent)
    expect(new Set(ids).size).toBe(2)
  })

  test('(p) a retry whose options changed warns once, naming the fix', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const greeting = defineQuery({
      id: 'hydration-boundary/changing-options',
      key: () => [],
      // Never settles: React 19's prerender of the suspended tree is the one
      // retry, so the test sees a rebuild without an endless loop.
      fetcher: () => new Promise<string>(() => {}),
    })
    const def = defineController((ctx) => ({ greeting: createQuery(ctx, greeting) }))
    function Show() {
      const root = useRoot<{ greeting: Parameters<typeof useSuspenseQuery<string>>[0] }>()
      return <span>{useSuspenseQuery(root.greeting).data}</span>
    }
    function App() {
      // A new `hydrate` object per render: the retry cannot reuse the root.
      return (
        <HydrationBoundary
          def={def}
          options={{ deps: {}, queries: queryEngine(), hydrate: { version: 1, entries: [] } }}
        >
          <Show />
        </HydrationBoundary>
      )
    }
    render(
      <Suspense fallback={<span>loading</span>}>
        <App />
      </Suspense>,
    )
    await act(async () => {})
    const rebuilds = warn.mock.calls.filter((c) => /built a second root/.test(String(c[0])))
    expect(rebuilds).toHaveLength(1)
    expect(String(rebuilds[0]?.[0])).toMatch(/<Suspense> inside the boundary/)
    warn.mockRestore()
  })

  test('(k) one element rendered twice gets two independent roots', () => {
    let n = 0
    const disposes = vi.fn()
    const def = defineController((ctx) => {
      const id = ++n
      ctx.onDispose(disposes)
      return { id }
    })
    function Show() {
      return <span>{useRoot<{ id: number }>().id}</span>
    }
    const element = (
      <HydrationBoundary def={def} options={{ deps: {} }}>
        <Show />
      </HydrationBoundary>
    )
    const { container } = render(
      <>
        {element}
        {element}
      </>,
    )
    const ids = [...container.querySelectorAll('span')].map((s) => s.textContent)
    expect(new Set(ids).size).toBe(2)
    expect(n - disposes.mock.calls.length).toBe(2)
  })
})
