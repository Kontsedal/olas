// @vitest-environment jsdom

import { defineController } from '@kontsedal/olas-core'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { HydrationBoundary, useRoot } from '../src'

afterEach(() => cleanup())

// R4.1 (T4.1) — HydrationBoundary must NOT build the root in useMemo (side-
// effectful; StrictMode double-invokes it → orphaned live root). It must own
// the root with ref+effect lifecycle: dispose on unmount, read `options` once,
// recreate only on `def` identity change.
describe('HydrationBoundary lifecycle (R4.1)', () => {
  test('(a) unmount disposes the root', () => {
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
})
