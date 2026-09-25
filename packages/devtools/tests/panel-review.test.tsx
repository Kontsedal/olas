// @vitest-environment jsdom

// Regressions for the second review round: cancelled mutation runs, data
// shapes that threw during render, query-key objects shown as
// `[object Object]`, the launcher losing its history, and `urlHashKey`
// rewriting the app's own hash.

import {
  computed,
  createRoot,
  type DebugCacheEntry,
  type DebugEvent,
  defineController,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsLauncher } from '../src/DevtoolsLauncher'
import { DevtoolsPanel } from '../src/DevtoolsPanel'
import { DevtoolsStore } from '../src/store'

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
      queryEntries: (): DebugCacheEntry[] => entries,
    },
  }
  /** Deliver events, then advance one frame so the rAF-coalesced store flushes. */
  const emit = (...events: DebugEvent[]) =>
    act(() => {
      for (const e of events) for (const h of [...handlers]) h(e)
      vi.advanceTimersToNextFrame()
    })
  return { root, emit, handlers }
}

const body = () => screen.getByRole('tabpanel')
const targets = () =>
  [...body().querySelectorAll('.olas-devtools-target')].map((n) => n.textContent)
const tab = (name: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(name) }))
const launcher = () => screen.getByRole('button', { name: /Olas devtools$/ })
const HostApp = () => <p>host app</p>

// On Node >= 25 the global `localStorage` is Node's own, `undefined` without a
// flag; install jsdom's so the launcher's persistence runs (coverage-launcher does the same).
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const jsdomStorage = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window
  .localStorage

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: jsdomStorage,
  })
  localStorage.clear()
  vi.useFakeTimers()
  window.history.replaceState(null, '', window.location.pathname)
  // React reports a caught render error through console.error; keep it quiet.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
})

// ---------------------------------------------------------------------------
// Finding 1: a cancelled run is closed, not left running
// ---------------------------------------------------------------------------

describe('a cancelled mutation run', () => {
  const PATH = ['root']
  const at = (t: number, e: Record<string, unknown>) => ({ path: PATH, id: 'search', t, ...e })
  const events = [
    at(0, { type: 'controller:constructed', props: undefined }),
    at(0, { type: 'mutation:run', vars: 'a', causeId: 'r1' }),
    at(100, { type: 'mutation:cancel', reason: 'superseded', causeId: 'r1' }),
    at(100, { type: 'mutation:run', vars: 'ab', causeId: 'r2' }),
  ] as unknown as DebugEvent[]

  test('closes its timeline group with the reason instead of leaving it active', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="timeline" />)
    bus.emit(...events)
    const groups = [...body().querySelectorAll('.olas-devtools-tl-group')]
    // Newest first: r2 is still running, r1 was superseded.
    expect(groups).toHaveLength(2)
    expect(groups[0]?.className).toContain('olas-devtools-tl-group-active')
    expect(groups[1]?.className).not.toContain('olas-devtools-tl-group-active')
    expect(groups[1]?.textContent).toContain('cancel')
    expect(groups[1]?.textContent).toContain('search · root (superseded)')
  })

  test('shows as cancelled in the Mutations log and drops the pending badge', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="mutations" />)
    // The store times a run on its own clock, at delivery.
    bus.emit(...events.slice(0, 2))
    act(() => {
      vi.advanceTimersByTime(100)
    })
    bus.emit(...events.slice(2))
    const cancelRow = [...body().querySelectorAll('li')].find(
      (li) => li.querySelector('.olas-devtools-kind')?.textContent === 'cancel',
    )
    // Each emit also advances one fake frame, so the run took at least 100ms.
    const suffix = cancelRow?.querySelector('.olas-devtools-duration')?.textContent ?? ''
    expect(suffix).toMatch(/^superseded · \d+ms$/)
    expect(Number.parseInt(suffix.slice('superseded · '.length), 10)).toBeGreaterThanOrEqual(100)
    tab('Tree')
    // r2 is the only run still in flight.
    expect(body().textContent).toContain('1 pending')
  })
})

// ---------------------------------------------------------------------------
// Findings 2 and 3: data shapes that threw, and object key members
// ---------------------------------------------------------------------------

describe('query keys with object members', () => {
  const bare = (fields: Record<string, unknown>) =>
    Object.assign(Object.create(null) as Record<string, unknown>, fields)

  test('a null-prototype object in a key renders as JSON in every view', () => {
    const key = ['search', bare({ q: 'ada' })]
    const entry = {
      queryId: 'search',
      key,
      status: 'success',
      data: 1,
      error: undefined,
      lastUpdatedAt: 1,
      isStale: false,
      isFetching: false,
      hasPendingMutations: false,
    } as DebugCacheEntry
    const bus = fakeRoot([entry])
    render(
      <>
        <HostApp />
        <DevtoolsPanel root={bus.root} defaultTab="cache" />
      </>,
    )
    bus.emit({ type: 'cache:fetch-start', queryId: 'search', queryKey: key })
    expect(targets()).toEqual(['search › {"q":"ada"}'])
    // The filter builds its haystack from the key too.
    act(() => {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ada' } })
      vi.advanceTimersByTime(150)
    })
    expect(targets()).toEqual(['search › {"q":"ada"}'])
    tab('Timeline')
    expect(targets()).toEqual(['search › {"q":"ada"}'])
    tab('Insp')
    act(() => {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ada' } })
      vi.advanceTimersByTime(150)
    })
    expect(targets()).toEqual(['search › {"q":"ada"}'])
    expect(screen.getByText('host app')).toBeTruthy()
  })

  test('two keys that differ only inside an object member read differently', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" />)
    bus.emit(
      { type: 'cache:fetch-start', queryKey: ['users', { page: 1 }] },
      { type: 'cache:fetch-start', queryKey: ['users', { page: 2 }] },
    )
    expect(targets()).toEqual(['users › {"page":2}', 'users › {"page":1}'])
  })
})

describe('a ctx.debug computed that throws', () => {
  function app() {
    const items = signal<Array<{ name: string }>>([])
    const def = defineController((ctx) => {
      ctx.debug({ first: computed(() => (items.value[0] as { name: string }).name) })
      return {}
    })
    return { items, root: createRoot(def, { deps: {} }) }
  }
  const variable = () =>
    screen.getByText('first:', { selector: '.olas-devtools-var-name' }).parentElement as HTMLElement

  test('shows the error inline and keeps the host app mounted', () => {
    const { items, root } = app()
    render(
      <>
        <HostApp />
        <DevtoolsPanel root={root} defaultTab="tree" />
      </>,
    )
    expect(screen.getByText('host app')).toBeTruthy()
    expect(variable().textContent).toContain('TypeError')
    act(() => items.set([{ name: 'Ada' }]))
    expect(variable().textContent).toContain('"Ada"')
    root.dispose()
  })

  test("a write that makes it throw does not throw into the app's write", () => {
    const { items, root } = app()
    items.set([{ name: 'Ada' }])
    render(<DevtoolsPanel root={root} defaultTab="tree" />)
    expect(variable().textContent).toContain('"Ada"')
    expect(() => act(() => items.set([]))).not.toThrow()
    expect(variable().textContent).toContain('TypeError')
    root.dispose()
  })
})

describe('an error boundary around the panel and the launcher', () => {
  // A props object whose keys cannot be listed: the tree row's summary throws.
  const hostile = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('hostile props')
      },
    },
  )

  test('a render error inside the panel shows a fallback, not a blank host app', () => {
    const bus = fakeRoot()
    render(
      <>
        <HostApp />
        <DevtoolsPanel root={bus.root} defaultTab="tree" />
      </>,
    )
    bus.emit({ type: 'controller:constructed', path: ['root'], props: hostile })
    expect(screen.getByText('host app')).toBeTruthy()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('hostile props')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  test('a bus that throws on subscribe never takes the host app down', () => {
    localStorage.setItem('olas-devtools-window', JSON.stringify({ open: true }))
    const root = {
      debug: {
        subscribe: (): (() => void) => {
          throw new Error('bus down')
        },
        queryEntries: (): DebugCacheEntry[] => [],
      },
    }
    render(
      <>
        <HostApp />
        <DevtoolsLauncher root={root} />
      </>,
    )
    expect(screen.getByText('host app')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Finding 4: the launcher keeps one store for its lifetime
// ---------------------------------------------------------------------------

describe('the launcher owns its store', () => {
  const run = (vars: string, causeId: string): DebugEvent => ({
    type: 'mutation:run',
    path: ['root'],
    id: 'save',
    vars,
    causeId,
  })
  const runCount = () =>
    [...body().querySelectorAll('.olas-devtools-kind')].filter((k) => k.textContent === 'run')
      .length

  test('records from mount, before the window first opens', () => {
    const bus = fakeRoot()
    render(<DevtoolsLauncher root={bus.root} defaultTab="mutations" />)
    expect(bus.handlers.size).toBe(1)
    bus.emit(run('early', 'r1'))
    fireEvent.click(launcher())
    expect(runCount()).toBe(1)
  })

  test('closing, minimizing and reopening the window keeps the history', () => {
    const bus = fakeRoot()
    const { unmount } = render(<DevtoolsLauncher root={bus.root} defaultTab="mutations" />)
    fireEvent.click(launcher())
    bus.emit(run('a', 'r1'))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    bus.emit(run('b', 'r2'))
    fireEvent.click(launcher())
    expect(runCount()).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }))
    bus.emit(run('c', 'r3'))
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }))
    expect(runCount()).toBe(3)
    expect(bus.handlers.size).toBe(1)
    unmount()
    expect(bus.handlers.size).toBe(0)
  })

  test('a panel handed a store renders it and leaves attaching to its owner', () => {
    const bus = fakeRoot()
    const store = new DevtoolsStore()
    const detach = store.attach(bus.root)
    const { unmount } = render(
      <DevtoolsPanel root={bus.root} store={store} defaultTab="mutations" />,
    )
    expect(bus.handlers.size).toBe(1)
    bus.emit(run('a', 'r1'))
    expect(runCount()).toBe(1)
    unmount()
    expect(bus.handlers.size).toBe(1)
    detach()
  })
})

// ---------------------------------------------------------------------------
// Finding 5: urlHashKey leaves the app's own hash alone
// ---------------------------------------------------------------------------

describe('urlHashKey and the rest of the hash', () => {
  const panel = () => render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" />)

  test.each([
    ['a hash-router path with a query', '#/users/42?tab=posts'],
    ['an anchor', '#section'],
    ['a hash-bang route', '#!/inbox'],
  ])('a hash that is not key=value pairs is never rewritten: %s', (_label, hash) => {
    window.history.replaceState(null, '', hash)
    const replace = vi.spyOn(window.history, 'replaceState')
    panel()
    tab('Cache')
    expect(window.location.hash).toBe(hash)
    expect(replace).not.toHaveBeenCalled()
  })

  test('other key=value segments keep their exact bytes', () => {
    window.history.replaceState(null, '', '#a=1&b=x%20y')
    panel()
    expect(window.location.hash.startsWith('#a=1&b=x%20y&dt=')).toBe(true)
    tab('Cache')
    const hash = window.location.hash
    expect(hash.startsWith('#a=1&b=x%20y&dt=')).toBe(true)
    expect(hash.split('&dt=')).toHaveLength(2)
    expect(decodeURIComponent(new URLSearchParams(hash.slice(1)).get('dt') ?? '')).toContain(
      '"tab":"cache"',
    )
  })

  test('the panel segment is replaced where it stands', () => {
    window.history.replaceState(null, '', '#dt=x&z=1')
    panel()
    expect(window.location.hash).toMatch(/^#dt=[^&]+&z=1$/)
    expect(window.location.hash).not.toBe('#dt=x&z=1')
  })

  test("the router's history.state survives the write", () => {
    window.history.replaceState({ idx: 3 }, '', '#a=1')
    panel()
    expect(window.location.hash.startsWith('#a=1&dt=')).toBe(true)
    expect(window.history.state).toEqual({ idx: 3 })
  })
})
