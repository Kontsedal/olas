// @vitest-environment jsdom

import type { DebugEvent } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
      queryEntries: () => [],
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

const fetchStart = (key: string): DebugEvent => ({ type: 'cache:fetch-start', queryKey: [key] })
const body = () => screen.getByRole('tabpanel')
const targets = () =>
  [...body().querySelectorAll('.olas-devtools-target')].map((n) => n.textContent)
const searchbox = () => screen.getByRole('searchbox') as HTMLInputElement
const type = (value: string) =>
  act(() => {
    fireEvent.change(searchbox(), { target: { value } })
    vi.advanceTimersByTime(150) // past the filter debounce
  })
const hashState = (key: string) => {
  const raw = new URLSearchParams(window.location.hash.slice(1)).get(key)
  return raw === null ? null : JSON.parse(decodeURIComponent(raw))
}
const setHash = (hash: string) => window.history.replaceState(null, '', hash)

beforeEach(() => {
  vi.useFakeTimers()
  setHash(window.location.pathname) // no hash
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Pause', () => {
  test('freezes the visible log while events keep arriving; Resume shows them', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" />)
    bus.emit(fetchStart('k1'))
    const pause = screen.getByRole('button', { name: 'Pause' })
    expect(pause.getAttribute('aria-pressed')).toBe('false')
    expect(pause.getAttribute('title')).toBe('Pause live updates')

    fireEvent.click(pause)
    const resume = screen.getByRole('button', { name: 'Resume' })
    expect(resume.getAttribute('aria-pressed')).toBe('true')
    expect(resume.getAttribute('title')).toBe('Resume live updates')
    expect(resume.className).toContain('olas-devtools-pause-on')

    bus.emit(fetchStart('k2'))
    expect(targets()).toEqual(['k1']) // frozen
    // The tab badge keeps counting live events.
    const cacheTab = screen.getByRole('tab', { name: 'Cache' })
    expect(cacheTab.querySelector('.olas-devtools-tab-count')?.textContent).toBe('2')

    fireEvent.click(resume)
    expect(targets()).toEqual(['k2', 'k1'])
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy()
  })
})

describe('Filter input', () => {
  test('placeholder names the tab; the clear button empties the filter and disappears', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" />)
    bus.emit(fetchStart('alpha'), fetchStart('beta'))
    expect(searchbox().getAttribute('placeholder')).toBe('Filter cache…')
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull()

    type('alpha')
    expect(targets()).toEqual(['alpha'])
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(searchbox().value).toBe('')
    expect(screen.queryByRole('button', { name: 'Clear filter' })).toBeNull()
    expect(targets()).toEqual(['beta', 'alpha'])
  })

  test('each tab keeps its own filter text', () => {
    render(<DevtoolsPanel root={fakeRoot().root} defaultTab="cache" />)
    type('abc')
    fireEvent.click(screen.getByRole('tab', { name: 'Mutations' }))
    expect(searchbox().value).toBe('')
    expect(searchbox().getAttribute('placeholder')).toBe('Filter mutations…')
    fireEvent.click(screen.getByRole('tab', { name: 'Cache' }))
    expect(searchbox().value).toBe('abc')
  })

  test('a whitespace-only filter matches everything', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" />)
    bus.emit(fetchStart('a'), fetchStart('b'))
    type('   ')
    expect(targets()).toEqual(['b', 'a'])
  })
})

describe('maxEntries', () => {
  test('caps each view log to the newest N entries', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" maxEntries={2} />)
    bus.emit(fetchStart('k1'), fetchStart('k2'), fetchStart('k3'))
    expect(targets()).toEqual(['k3', 'k2'])
  })
})

describe('URL-hash persistence (urlHashKey)', () => {
  test('writes tab + filters to the hash and restores them on the next mount', () => {
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" />)
    expect(hashState('dt')).toMatchObject({ tab: 'timeline' })
    fireEvent.click(screen.getByRole('tab', { name: 'Cache' }))
    type('users')
    expect(hashState('dt')).toMatchObject({ tab: 'cache', filters: { cache: 'users' } })

    cleanup()
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" />)
    expect(screen.getByRole('tab', { name: 'Cache' }).getAttribute('aria-selected')).toBe('true')
    expect(searchbox().value).toBe('users')
  })

  test('keeps unrelated hash params', () => {
    setHash('#other=1')
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" />)
    const params = new URLSearchParams(window.location.hash.slice(1))
    expect(params.get('other')).toBe('1')
    expect(params.get('dt')).not.toBeNull()
  })

  test('does not rewrite the hash when it already holds the current state', () => {
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" defaultTab="fields" />)
    cleanup()
    const replace = vi.spyOn(window.history, 'replaceState')
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" defaultTab="fields" />)
    expect(replace).not.toHaveBeenCalled()
  })

  test('without urlHashKey the hash is never touched', () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    render(<DevtoolsPanel root={fakeRoot().root} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Cache' }))
    type('x')
    expect(replace).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })

  test.each([
    ['the key is absent', '#other=1'],
    ['the stored value is not JSON', '#dt=%257Bbroken'],
  ])('falls back to defaultTab and empty filters when %s', (_label, hash) => {
    setHash(hash)
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" defaultTab="mutations" />)
    expect(screen.getByRole('tab', { name: 'Mutations' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    expect(searchbox().value).toBe('')
  })

  test.each([
    ['only a tab', { tab: 'fields' }, 'Fields', ''],
    ['only filters', { filters: { mutations: 'save' } }, 'Mutations', 'save'],
  ])('restores a partial state holding %s', (_label, state, tabName, filterText) => {
    setHash(`#dt=${encodeURIComponent(encodeURIComponent(JSON.stringify(state)))}`)
    render(<DevtoolsPanel root={fakeRoot().root} urlHashKey="dt" defaultTab="mutations" />)
    expect(screen.getByRole('tab', { name: tabName }).getAttribute('aria-selected')).toBe('true')
    expect(searchbox().value).toBe(filterText)
  })
})
