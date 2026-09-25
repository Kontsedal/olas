// @vitest-environment jsdom

// A root's debug bus replays its live controller tree to every new
// subscriber. Attaching one store to the same bus again, as StrictMode's
// effect replay does to a panel's own store, used to log that replay again:
// two controllers, attach, detach, attach, and four `controller:constructed`
// rows on the timeline.

import { createRoot, defineController } from '@kontsedal/olas-core'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'
import { DevtoolsStore } from '../src/store'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

/** A root with two live controllers: the root and one child. */
function twoControllers() {
  const child = defineController(() => ({}))
  return createRoot(
    defineController((ctx) => {
      ctx.child(child, undefined)
      return {}
    }),
    { deps: {} },
  )
}

const kinds = (store: DevtoolsStore, type: string) =>
  store.events$.peek().filter((e) => e.event.type === type)

describe('attaching a store to the same bus again', () => {
  test('the replayed tree is logged once, and the tree stays whole', () => {
    const root = twoControllers()
    const store = new DevtoolsStore()
    store.attach(root)()
    const detach = store.attach(root)
    expect(kinds(store, 'controller:constructed')).toHaveLength(2)
    expect(store.tree$.peek().children[0]?.children).toHaveLength(1)
    detach()
    root.dispose()
  })

  test('what changed while detached is logged: a controller suspended meanwhile', () => {
    const root = twoControllers()
    const store = new DevtoolsStore()
    store.attach(root)()
    root.suspend()
    const detach = store.attach(root)
    // The replay's constructs repeat the tree; its suspends are news.
    expect(kinds(store, 'controller:constructed')).toHaveLength(2)
    expect(kinds(store, 'controller:suspended')).toHaveLength(2)
    expect(store.tree$.peek().children[0]?.state).toBe('suspended')
    // Attached once more, nothing is new.
    detach()
    const again = store.attach(root)
    expect(kinds(store, 'controller:suspended')).toHaveLength(2)
    expect(store.tree$.peek().children[0]?.state).toBe('suspended')
    again()
    root.dispose()
  })

  test('a controller resumed while detached shows active again', () => {
    const root = twoControllers()
    root.suspend()
    const store = new DevtoolsStore()
    store.attach(root)()
    root.resume()
    const detach = store.attach(root)
    expect(store.tree$.peek().children[0]?.state).toBe('active')
    expect(kinds(store, 'controller:constructed')).toHaveLength(2)
    detach()
    root.dispose()
  })
})

describe('a bus that replays more than the tree', () => {
  test('an event of another type, delivered inside subscribe, still gets its row', () => {
    const bus = {
      debug: {
        subscribe: (handler: (e: import('@kontsedal/olas-core').DebugEvent) => void) => {
          handler({ type: 'controller:constructed', path: ['root'], props: undefined })
          handler({ type: 'cache:gc', queryKey: ['u'] })
          return () => {}
        },
        queryEntries: () => [],
      },
    }
    const store = new DevtoolsStore()
    store.attach(bus)
    store.attach(bus)
    expect(kinds(store, 'controller:constructed')).toHaveLength(1)
    expect(kinds(store, 'cache:gc')).toHaveLength(2)
  })
})

describe('the panel under StrictMode', () => {
  test('its own store logs the replayed tree once', () => {
    vi.useFakeTimers()
    const root = twoControllers()
    render(
      <StrictMode>
        <DevtoolsPanel root={root} />
      </StrictMode>,
    )
    act(() => {
      vi.advanceTimersToNextFrame()
    })
    const rows = screen.getAllByText('constructed', { selector: '.olas-devtools-kind' })
    expect(rows).toHaveLength(2)
    root.dispose()
  })
})
