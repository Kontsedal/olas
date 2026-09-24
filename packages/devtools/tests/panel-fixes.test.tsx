// @vitest-environment jsdom

// Regressions for four bugs the 1.0 coverage pass found in the panel and the
// launcher.

import type { DebugCacheEntry, DebugEvent } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsLauncher } from '../src/DevtoolsLauncher'
import { DevtoolsPanel } from '../src/DevtoolsPanel'

function fakeRoot() {
  const handlers = new Set<(e: DebugEvent) => void>()
  const root = {
    debug: {
      subscribe: (h: (e: DebugEvent) => void) => {
        handlers.add(h)
        return () => {
          handlers.delete(h)
        }
      },
      queryEntries: (): DebugCacheEntry[] => [],
    },
  }
  const emit = (...events: DebugEvent[]) =>
    act(() => {
      for (const e of events) for (const h of [...handlers]) h(e)
      vi.advanceTimersToNextFrame()
    })
  return { root, emit }
}

const constructed = (path: string[]): DebugEvent =>
  ({ type: 'controller:constructed', path, props: undefined }) as DebugEvent
const nodeRow = (name: string) =>
  screen.getByText(name, { selector: '.olas-devtools-tree-name' }).parentElement as HTMLElement

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('DevtoolsPanel', () => {
  test('the Tree tab counts every live controller, the root wrapper excluded', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="timeline" />)
    bus.emit(constructed(['root']), constructed(['root', 'a']))
    const tree = screen.getByRole('tab', { name: /Tree/ })
    expect(tree.querySelector('.olas-devtools-tab-count')?.textContent).toBe('2')
  })

  test("one mutation's settle does not clear another's pending badge", () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root']), {
      type: 'mutation:run',
      path: ['root'],
      name: 'a',
      vars: 1,
    })
    expect(nodeRow('root').textContent).toContain('1 pending')
    // `b` ran before the panel mounted; only its settle arrives.
    bus.emit({ type: 'mutation:success', path: ['root'], name: 'b', result: 1 })
    expect(nodeRow('root').textContent).toContain('1 pending')
  })

  test("switching tabs never applies the previous tab's filter, even inside the debounce", () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="mutations" />)
    // A cache entry, so a stale filter would visibly hide it.
    bus.emit({ type: 'cache:fetch-start', queryId: 'user', queryKey: ['user'] })
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } })
    act(() => {
      vi.advanceTimersByTime(200)
    })
    fireEvent.click(screen.getByRole('tab', { name: /Cache/ }))
    expect(screen.getByRole('tabpanel').textContent).not.toContain('zzz')
    expect(screen.getByRole('tabpanel').textContent).toContain('user')
  })
})

describe('DevtoolsLauncher', () => {
  test('renders when reading localStorage throws (sandboxed iframe, blocked storage)', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      render(<DevtoolsLauncher root={fakeRoot().root} />)
      expect(screen.getByRole('button', { name: /Olas devtools$/ })).toBeTruthy()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })
})
