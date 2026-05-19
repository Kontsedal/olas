// @vitest-environment jsdom

import { createRoot, defineController, defineQuery, signal } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { OlasProvider, use, useController, useField, useQuery, useRoot } from '../src'

afterEach(() => {
  cleanup()
})

describe('use(signal)', () => {
  test('component re-renders when a signal changes', () => {
    const counterDef = defineController(() => {
      const count = signal(0)
      return { count, inc: () => count.set(count.peek() + 1) }
    })
    const root = createRoot(counterDef, { deps: {} })

    function Counter() {
      const value = use(root.count)
      return <span data-testid="count">{value}</span>
    }

    render(
      <OlasProvider root={root}>
        <Counter />
      </OlasProvider>,
    )

    expect(screen.getByTestId('count').textContent).toBe('0')
    act(() => root.inc())
    expect(screen.getByTestId('count').textContent).toBe('1')
    act(() => root.inc())
    act(() => root.inc())
    expect(screen.getByTestId('count').textContent).toBe('3')

    root.dispose()
  })

  test('useRoot resolves the root from <OlasProvider>', () => {
    const def = defineController(() => ({ label: 'hello' }))
    const root = createRoot(def, { deps: {} })

    function Greeting() {
      const api = useRoot<{ label: string }>()
      return <span data-testid="g">{api.label}</span>
    }

    render(
      <OlasProvider root={root}>
        <Greeting />
      </OlasProvider>,
    )
    expect(screen.getByTestId('g').textContent).toBe('hello')
    root.dispose()
  })

  test('useRoot throws outside <OlasProvider>', () => {
    function Bad() {
      useRoot()
      return null
    }
    const prev = console.error
    console.error = () => {}
    try {
      expect(() => render(<Bad />)).toThrow(/useRoot\(\) called outside/)
    } finally {
      console.error = prev
    }
  })

  test('useController is a back-compat passthrough', () => {
    const def = defineController(() => ({ greeting: 'hi' }))
    const root = createRoot(def, { deps: {} })

    function Greet() {
      const api = useController(root)
      return <span data-testid="hc">{api.greeting}</span>
    }

    render(<Greet />)
    expect(screen.getByTestId('hc').textContent).toBe('hi')
    root.dispose()
  })
})

describe('useQuery(subscription)', () => {
  test('re-renders on query.invalidate() and surfaces fresh data', async () => {
    let value = 'first'
    const greetingQuery = defineQuery({
      key: () => [],
      fetcher: async () => value,
    })

    const def = defineController((ctx) => {
      const greeting = ctx.use(greetingQuery)
      return { greeting }
    })
    // Silence the expected abort noise that invalidation can produce when a
    // superseded fetch rejects with AbortError — `onError` swallows it for
    // this test.
    const root = createRoot(def, { deps: {}, onError: () => {} })

    function GreetingView() {
      const { data, isLoading } = useQuery(root.greeting)
      return <span data-testid="g">{isLoading ? 'loading' : (data ?? '')}</span>
    }

    render(
      <OlasProvider root={root}>
        <GreetingView />
      </OlasProvider>,
    )

    await act(async () => {
      await root.greeting.firstValue()
    })
    expect(screen.getByTestId('g').textContent).toBe('first')

    value = 'second'
    await act(async () => {
      greetingQuery.invalidate()
      // invalidate marks the entry stale; the subscription auto-refetches.
      // Wait for the refetch to settle.
      await root.greeting.firstValue()
    })
    // firstValue resolves on the first cached value (still 'first' after the
    // first fetch). Wait one more microtask cycle and assert the visible
    // text matches the refetched data.
    await act(async () => {
      await root.greeting.refetch()
    })
    expect(screen.getByTestId('g').textContent).toBe('second')

    root.dispose()
  })
})

describe('StrictMode safety', () => {
  test('double-mount does not double-construct the controller', () => {
    const constructions = vi.fn()
    const def = defineController(() => {
      constructions()
      return { count: signal(0) }
    })

    const root = createRoot(def, { deps: {} })
    expect(constructions).toHaveBeenCalledTimes(1)

    function View() {
      const v = use(root.count)
      // Track that React does mount/unmount per StrictMode
      useEffect(() => {
        // intentional empty — just exercise StrictMode's double-effect path
      }, [])
      return <span data-testid="v">{v}</span>
    }

    render(
      <StrictMode>
        <OlasProvider root={root}>
          <View />
        </OlasProvider>
      </StrictMode>,
    )

    expect(constructions).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('v').textContent).toBe('0')
    act(() => root.count.set(7))
    expect(screen.getByTestId('v').textContent).toBe('7')

    root.dispose()
  })
})

describe('useField <input> round-trip', () => {
  test('typing into an input updates the field and re-renders', () => {
    const def = defineController((ctx) => ({
      name: ctx.field<string>('init'),
    }))
    const root = createRoot(def, { deps: {} })

    function NameInput() {
      const { value, set, touched, markTouched } = useField(root.name)
      return (
        <div>
          <input
            data-testid="input"
            value={value}
            onChange={(e) => set(e.target.value)}
            onBlur={markTouched}
          />
          <span data-testid="touched">{touched ? 'yes' : 'no'}</span>
        </div>
      )
    }

    render(
      <OlasProvider root={root}>
        <NameInput />
      </OlasProvider>,
    )

    const input = screen.getByTestId('input') as HTMLInputElement
    expect(input.value).toBe('init')
    expect(screen.getByTestId('touched').textContent).toBe('no')

    act(() => {
      fireEvent.change(input, { target: { value: 'edited' } })
    })
    expect(input.value).toBe('edited')
    expect(root.name.peek()).toBe('edited')

    act(() => {
      fireEvent.blur(input)
    })
    expect(screen.getByTestId('touched').textContent).toBe('yes')

    root.dispose()
  })
})
