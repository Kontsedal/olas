// @vitest-environment jsdom

import {
  createRoot,
  type DebugCacheEntry,
  type DebugEvent,
  defineController,
  definePlugin,
  type PluginHost,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'
import { SearchIndex } from '../src/search'

// T8.2 (windowed lists, ring buffer indicator, frozen disposed nodes), T8.3
// (omnibox) and T8.8's plugin lanes, panel side.

function fakeRoot(entries: DebugCacheEntry[] = []) {
  const handlers = new Set<(e: DebugEvent) => void>()
  const root = {
    debug: {
      subscribe: (h: (e: DebugEvent) => void) => {
        handlers.add(h)
        return () => {
          handlers.delete(h)
        }
      },
      queryEntries: () => entries.slice(),
    },
  }
  /** Deliver events, then advance one frame so the rAF-coalesced store flushes. */
  const emit = (...events: DebugEvent[]) =>
    act(() => {
      for (const e of events) for (const h of [...handlers]) h(e)
      vi.advanceTimersToNextFrame()
    })
  return { root, emit }
}

const body = () => screen.getByRole('tabpanel')
const scroller = () => body().querySelector('.olas-devtools-vlist') as HTMLElement
const scrollTo = (top: number) => {
  Object.defineProperty(scroller(), 'scrollTop', { configurable: true, writable: true, value: top })
  fireEvent.scroll(scroller())
}
const targets = () =>
  [...body().querySelectorAll('.olas-devtools-target')].map((n) => n.textContent)
const constructed = (path: string[], extra: Partial<DebugEvent> = {}): DebugEvent =>
  ({ type: 'controller:constructed', path, props: undefined, ...extra }) as DebugEvent
const invalidated = (k: string): DebugEvent => ({ type: 'cache:invalidated', queryKey: [k] })
const omnibox = () =>
  screen.getByRole('combobox', { name: 'Search everything' }) as HTMLInputElement
const typeSearch = (value: string) => act(() => fireEvent.change(omnibox(), { target: { value } }))
const press = (key: string) => act(() => fireEvent.keyDown(omnibox(), { key }))
const lane = (name: RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement
const nodeRow = (name: string) =>
  screen
    .getByText(name, { selector: '.olas-devtools-tree-name' })
    .closest('[role="treeitem"]') as HTMLElement

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('windowed lists — T8.2', () => {
  test('a 10,000-event timeline mounts a bounded window, and scrolling moves it', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(...Array.from({ length: 10_000 }, (_, i) => invalidated(`k${i}`)))
    expect(screen.getByRole('tab', { name: 'Timeline' }).textContent).toContain('10000')
    const mounted = body().querySelectorAll('.olas-devtools-tl-row').length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(60)
    expect(targets()).toContain('k9999') // newest first, at the top

    scrollTo(31 * 5000) // row height estimate × index
    const after = targets()
    expect(after).not.toContain('k9999')
    expect(after).toContain('k5000')
    expect(body().querySelectorAll('.olas-devtools-tl-row').length).toBeLessThanOrEqual(60)
  })

  test('a 10,000-row cache log mounts a bounded number of <li>', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" maxEntries={10_000} />)
    bus.emit(...Array.from({ length: 10_000 }, (_, i) => invalidated(`k${i}`)))
    expect(body().querySelectorAll('li').length).toBeLessThanOrEqual(60)
    scrollTo(33 * 9000)
    expect(targets()).toContain('k1000')
  })

  test('a 1,000-controller tree mounts a bounded number of rows; collapse hides a subtree', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(
      constructed(['root']),
      ...Array.from({ length: 999 }, (_, i) => constructed(['root', `item[${i}]`])),
    )
    expect(screen.getAllByRole('treeitem').length).toBeLessThanOrEqual(60)
    expect(nodeRow('root').getAttribute('aria-expanded')).toBe('true')
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Collapse root' })))
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    expect(nodeRow('root').getAttribute('aria-expanded')).toBe('false')
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Expand root' })))
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(1)
  })

  test('a row keeps its expanded state when it scrolls out of the window and back', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      { type: 'mutation:run', path: ['root'], name: 'save', vars: { id: 1 } },
      ...Array.from({ length: 200 }, (_, i) => invalidated(`k${i}`)),
    )
    scrollTo(31 * 200)
    const run = screen.getByText('run', { selector: '.olas-devtools-kind' }).parentElement
    act(() => fireEvent.click(run as HTMLElement))
    expect(body().querySelector('.olas-devtools-payload-json')?.textContent).toBe('{id:1}')
    scrollTo(0)
    expect(body().querySelector('.olas-devtools-payload-json')).toBeNull() // unmounted
    scrollTo(31 * 200)
    expect(body().querySelector('.olas-devtools-payload-json')?.textContent).toBe('{id:1}')
  })

  test('an open cause-group mounts 100 events at a time, with a button for the rest', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      ...Array.from(
        { length: 150 },
        (): DebugEvent => ({ type: 'snapshot:push', queryKey: ['k'], causeId: 'big' }),
      ),
    )
    const head = body().querySelector('.olas-devtools-tl-group-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('false') // > 12 events start collapsed
    act(() => fireEvent.click(head))
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(100)
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Show 50 more of 50' })))
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(150)
    expect(screen.queryByRole('button', { name: /more of/ })).toBeNull()
  })
})

describe('ring buffer indicator — T8.2', () => {
  test('the timeline shows how many events the ring overwrote; Clear resets it', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} maxTimelineEntries={5} />)
    bus.emit(invalidated('a'), invalidated('b'))
    expect(body().querySelector('.olas-devtools-dropped')).toBeNull()
    bus.emit(...Array.from({ length: 6 }, (_, i) => invalidated(`k${i}`)))
    const dropped = body().querySelector('.olas-devtools-dropped') as HTMLElement
    expect(dropped.textContent).toBe('3 older dropped')
    expect(dropped.getAttribute('title')).toContain('newest 5 events')
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(5)
    act(() => fireEvent.click(screen.getByText('Clear')))
    expect(body().querySelector('.olas-devtools-dropped')).toBeNull()
  })
})

describe('disposed controllers — T8.2', () => {
  test('stay in the tree greyed, with their variables frozen at dispose time', () => {
    const count = signal(1)
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root']), constructed(['root', 'gone'], { debug: { count } }))
    bus.emit({ type: 'controller:disposed', path: ['root', 'gone'], t: 0 })
    const row = nodeRow('gone')
    expect(row.className).toContain('olas-devtools-tree-item-disposed')
    expect(nodeRow('root').className).not.toContain('disposed')
    const chip = row.querySelector('.olas-devtools-tree-state-disposed') as HTMLElement
    expect(chip.getAttribute('title')).toMatch(/^Disposed at .*; values frozen then$/)
    act(() => count.set(2))
    expect(row.querySelector('.olas-devtools-var-value')?.textContent).toBe('1')
  })
})

describe('plugin lanes — T8.8', () => {
  test('an event a plugin publishes through host.debug shows on its own lane and can be hidden', () => {
    let host: PluginHost | undefined
    const x = definePlugin({
      name: 'x',
      setup(h) {
        host = h
      },
    })
    const root = createRoot(
      defineController(() => ({})),
      { deps: {}, plugins: [x] },
    )
    render(<DevtoolsPanel root={root} />)
    act(() => {
      host?.debug({ synced: 3 })
      vi.advanceTimersToNextFrame()
    })
    const row = screen
      .getByText('x', { selector: '.olas-devtools-kind' })
      .closest('.olas-devtools-tl-row') as HTMLElement
    expect(row.querySelector('.olas-devtools-target')?.textContent).toBe('synced:3')
    const xLane = lane(/^x 1$/)
    expect(xLane.getAttribute('aria-pressed')).toBe('true')
    expect(lane(/^core/)).toBeTruthy() // the root's own lifecycle is the core lane

    act(() => fireEvent.click(xLane))
    expect(xLane.getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByText('x', { selector: '.olas-devtools-kind' })).toBeNull()
    expect(body().textContent).toContain('root') // core events still shown

    act(() => fireEvent.click(xLane))
    expect(screen.getByText('x', { selector: '.olas-devtools-kind' })).toBeTruthy()
    root.dispose()
  })

  test('with every lane hidden the timeline says so', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(invalidated('a'), { type: 'plugin:event', plugin: 'p', payload: 1 })
    act(() => fireEvent.click(lane(/^core/)))
    act(() => fireEvent.click(lane(/^p 1$/)))
    expect(body().textContent).toContain('Every lane is hidden')
  })

  test('no lane bar appears while only core events exist', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(invalidated('a'))
    expect(body().querySelector('.olas-devtools-lanes')).toBeNull()
  })
})

describe('the omnibox — T8.3', () => {
  const entry: DebugCacheEntry = {
    queryId: 'user',
    key: ['user', { id: 42, tab: 'posts' }],
    status: 'success',
    data: { name: 'Ada' },
    error: undefined,
    lastUpdatedAt: 0,
    isStale: false,
    isFetching: false,
    hasPendingMutations: false,
  }
  function seeded(defaultTab?: 'tree' | 'timeline') {
    const bus = fakeRoot([entry])
    render(<DevtoolsPanel root={bus.root} {...(defaultTab ? { defaultTab } : {})} />)
    bus.emit(
      constructed(['root']),
      constructed(['root', 'checkout']),
      constructed(['root', 'checkout', 'leaf']),
      { type: 'cache:fetch-start', queryKey: entry.key },
      { type: 'mutation:run', path: ['root', 'checkout'], name: 'pay', vars: { sku: 'zeta-9' } },
    )
    return bus
  }
  const options = () => screen.getAllByRole('option')
  const selected = () => options().find((o) => o.getAttribute('aria-selected') === 'true')

  test('/ focuses it from anywhere in the panel, but not from inside a field', () => {
    seeded()
    const panel = screen.getByTestId('olas-devtools')
    act(() => fireEvent.keyDown(screen.getByRole('searchbox'), { key: '/' }))
    expect(document.activeElement).not.toBe(omnibox())
    act(() => fireEvent.keyDown(panel, { key: '/', ctrlKey: true }))
    expect(document.activeElement).not.toBe(omnibox())
    act(() => fireEvent.keyDown(panel, { key: 'x' }))
    expect(document.activeElement).not.toBe(omnibox())
    act(() => fireEvent.keyDown(panel, { key: '/' }))
    expect(document.activeElement).toBe(omnibox())
  })

  test('groups results by kind: a controller, a query by key content, a payload value', () => {
    seeded()
    typeSearch('checkout')
    expect(
      within(screen.getByRole('listbox')).getByRole('group', { name: /Controllers/ }),
    ).toBeTruthy()
    expect(options()[0]?.textContent).toBe('checkoutroot › checkout')

    typeSearch('posts')
    expect(screen.getByRole('group', { name: /Queries/ }).textContent).toContain('user ›')

    typeSearch('zeta-9')
    const payloads = screen.getByRole('group', { name: /Payloads/ })
    expect(payloads.textContent).toContain('run · pay · root › checkout')

    typeSearch('nothing-like-this')
    expect(screen.getByRole('listbox').textContent).toBe('Nothing matches “nothing-like-this”.')
  })

  test('keystrokes reuse the index; only a change rebuilds it', () => {
    const build = vi.spyOn(SearchIndex.prototype as unknown as { build: () => void }, 'build')
    const bus = seeded()
    for (const q of ['c', 'ch', 'che', 'chec']) typeSearch(q)
    expect(build).toHaveBeenCalledTimes(1)
    bus.emit(constructed(['root', 'checkout2']))
    expect(build).toHaveBeenCalledTimes(2) // the open results refresh once
    typeSearch('check')
    typeSearch('checko')
    expect(build).toHaveBeenCalledTimes(2)
  })

  test('Enter jumps to the active result and highlights it', () => {
    seeded('timeline')
    typeSearch('checkout')
    press('Enter')
    expect(screen.getByRole('tab', { name: 'Tree' }).getAttribute('aria-selected')).toBe('true')
    expect(nodeRow('checkout').className).toContain('olas-devtools-hit')
    expect(screen.queryByRole('listbox')).toBeNull() // closed after the jump
  })

  test('arrows move the active option; the mouse can pick too', () => {
    seeded()
    typeSearch('root')
    expect(selected()).toBe(options()[0])
    press('ArrowDown')
    expect(selected()).toBe(options()[1])
    press('ArrowUp')
    press('ArrowUp') // clamps at the first
    expect(selected()).toBe(options()[0])
    const last = options()[options().length - 1] as HTMLElement
    act(() => fireEvent.mouseEnter(last))
    expect(selected()).toBe(last)
    act(() => fireEvent.mouseDown(options()[1] as HTMLElement))
    expect(screen.getByRole('tab', { name: 'Tree' }).getAttribute('aria-selected')).toBe('true')
  })

  test('Escape closes the results, then clears the query; blur closes them too', () => {
    seeded()
    typeSearch('checkout')
    press('Escape')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(omnibox().value).toBe('checkout')
    press('Escape')
    expect(omnibox().value).toBe('')
    typeSearch('checkout')
    act(() => fireEvent.blur(omnibox()))
    expect(screen.queryByRole('listbox')).toBeNull()
    act(() => fireEvent.focus(omnibox()))
    expect(screen.getByRole('listbox')).toBeTruthy()
    press('Enter') // with results open, Enter still jumps
    expect(screen.getByRole('tab', { name: 'Tree' }).getAttribute('aria-selected')).toBe('true')
  })

  test('Enter with no result does nothing', () => {
    seeded()
    typeSearch('nothing-like-this')
    press('Enter')
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true')
  })

  test('a jump into a collapsed subtree opens its ancestors', () => {
    seeded('tree')
    act(() => fireEvent.click(screen.getByRole('button', { name: 'Collapse root' })))
    expect(screen.queryByText('leaf', { selector: '.olas-devtools-tree-name' })).toBeNull()
    typeSearch('leaf')
    press('Enter')
    expect(nodeRow('leaf').className).toContain('olas-devtools-hit')
  })

  test('a jump to a query lands on its inspector row', () => {
    seeded()
    typeSearch('posts')
    press('Enter')
    expect(screen.getByRole('tab', { name: 'Inspector' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(body().querySelector('li')?.className).toContain('olas-devtools-hit')
  })

  test('a jump to an event opens its collapsed group, clears the filter and shows its lane', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      ...Array.from(
        { length: 20 },
        (_, i): DebugEvent => ({ type: 'snapshot:push', queryKey: [`k${i}`], causeId: 'run-1' }),
      ),
      {
        type: 'mutation:run',
        path: ['root'],
        name: 'pay',
        vars: { sku: 'deep-in-group' },
        causeId: 'run-1',
      },
      { type: 'plugin:event', plugin: 'sync', payload: { peer: 'tab-7' } },
    )
    act(() => fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } }))
    act(() => vi.advanceTimersByTime(200))
    act(() => fireEvent.click(lane(/^sync 1$/)))

    typeSearch('deep-in-group')
    press('Enter')
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
    const head = body().querySelector('.olas-devtools-tl-group-head') as HTMLElement
    expect(head.getAttribute('aria-expanded')).toBe('true')
    expect(body().querySelector('.olas-devtools-hit .olas-devtools-kind')?.textContent).toBe('run')

    typeSearch('tab-7')
    press('Enter')
    expect(lane(/^sync 1$/).getAttribute('aria-pressed')).toBe('true')
    expect(body().querySelector('.olas-devtools-hit .olas-devtools-kind')?.textContent).toBe('sync')
  })

  test('a jump deep into a large group pages far enough to mount the target', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      ...Array.from(
        { length: 130 },
        (_, i): DebugEvent => ({ type: 'snapshot:push', queryKey: [`k${i}`], causeId: 'run-1' }),
      ),
      {
        type: 'mutation:run',
        path: ['root'],
        name: 'late',
        vars: { needle: 'at-130' },
        causeId: 'run-1',
      },
    )
    typeSearch('at-130')
    press('Enter')
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(131)
    expect(body().querySelector('.olas-devtools-hit .olas-devtools-kind')?.textContent).toBe('run')
  })
})
