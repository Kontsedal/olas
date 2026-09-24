// @vitest-environment jsdom

import type { DebugCacheEntry, DebugEvent } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'

function fakeRoot(initial: DebugCacheEntry[] = []) {
  const handlers = new Set<(e: DebugEvent) => void>()
  let entries = initial
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
  const setEntries = (next: DebugCacheEntry[]) => {
    entries = next
  }
  return { root, emit, setEntries }
}

const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime()
const body = () => screen.getByRole('tabpanel')
const rows = () => [...body().querySelectorAll('li')] as HTMLElement[]
const kindOf = (row: HTMLElement) => row.querySelector('.olas-devtools-kind') as HTMLElement
const filter = (value: string) =>
  act(() => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value } })
    vi.advanceTimersByTime(150) // past the filter debounce
  })
const rowTop = (row: HTMLElement) => row.querySelector('.olas-devtools-row-top') as HTMLElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Cache log', () => {
  test('renders each kind newest-first with its colour, duration and detail', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" />)
    bus.emit(
      { type: 'cache:subscribed', queryKey: ['u'], subscriberPath: ['root', 'list'] },
      { type: 'cache:fetch-start', queryKey: ['u'] },
      { type: 'cache:fetch-success', queryKey: ['u'], durationMs: 12 },
      { type: 'cache:fetch-error', queryKey: ['u'], durationMs: 30, error: new Error('down') },
      { type: 'cache:invalidated', queryKey: ['u'] },
      { type: 'cache:gc', queryKey: ['u'] },
    )
    const [gc, invalidated, error, success, start, subscribed] = rows() as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ]
    expect(kindOf(gc).className).toContain('olas-devtools-kind-warn')
    expect(kindOf(invalidated).className).toContain('olas-devtools-kind-warn')
    expect(kindOf(error).className).toContain('olas-devtools-kind-error')
    expect(kindOf(success).className).toContain('olas-devtools-kind-success')
    expect(kindOf(start).className.trim()).toBe('olas-devtools-kind')
    expect(success.querySelector('.olas-devtools-duration')?.textContent).toBe('12ms')
    expect(error.querySelector('.olas-devtools-duration')?.textContent).toBe('30ms')
    expect(subscribed.querySelector('.olas-devtools-payload-inline')?.textContent).toBe(
      'from root › list',
    )
    // Only the fetch-error row carries an expandable payload.
    expect(rows().filter((r) => r.className === 'olas-devtools-row-clickable')).toEqual([error])
    fireEvent.click(rowTop(error))
    expect(error.querySelector('.olas-devtools-payload-json')?.textContent).toBe('Error("down")')
    expect(error.querySelector('.olas-devtools-chevron-open')).toBeTruthy()
    fireEvent.click(rowTop(error))
    expect(error.querySelector('.olas-devtools-payload-json')).toBeNull()
  })

  test('filters by kind, key, subscriber path and error text', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="cache" />)
    bus.emit(
      { type: 'cache:subscribed', queryKey: ['users'], subscriberPath: ['root', 'sidebar'] },
      { type: 'cache:fetch-error', queryKey: ['posts'], durationMs: 1, error: 'timeout' },
      { type: 'cache:fetch-start', queryKey: ['posts'] },
    )
    filter('sidebar')
    expect(rows().map((r) => kindOf(r).textContent)).toEqual(['subscribed'])
    filter('TIMEOUT')
    expect(rows().map((r) => kindOf(r).textContent)).toEqual(['fetch-error'])
    filter('posts')
    expect(rows()).toHaveLength(2)
    filter('nothing-here')
    expect(body().textContent).toContain('Nothing matches “nothing-here”.')
  })
})

describe('Mutations log', () => {
  test('renders run / success / error / rollback with payloads and paired durations', () => {
    let clock = NOW
    vi.setSystemTime(clock)
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="mutations" />)
    bus.emit({ type: 'mutation:run', path: ['root'], name: 'save', vars: { id: 1 } })
    clock += 40
    vi.setSystemTime(clock)
    bus.emit(
      { type: 'mutation:success', path: ['root'], name: 'save', result: 'ok' },
      { type: 'mutation:run', path: ['root', 'form'], vars: 'v' },
      { type: 'mutation:error', path: ['root', 'form'], error: 'bad' },
      { type: 'mutation:rollback', path: ['root', 'form'] },
      { type: 'mutation:error', path: ['root'], name: 'orphan', error: 'late' },
    )
    const [orphan, rollback, error, run2, success, run1] = rows() as HTMLElement[] as [
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
      HTMLElement,
    ]
    expect(kindOf(run1).className.trim()).toBe('olas-devtools-kind')
    expect(run1.querySelector('.olas-devtools-target')?.textContent).toBe('save · root')
    expect(kindOf(success).className).toContain('olas-devtools-kind-success')
    expect(success.querySelector('.olas-devtools-duration')?.textContent).toBe('40ms')
    expect(run2.querySelector('.olas-devtools-target')?.textContent).toBe('root › form')
    expect(kindOf(error).className).toContain('olas-devtools-kind-error')
    expect(error.querySelector('.olas-devtools-duration')?.textContent).toBe('0ms')
    expect(kindOf(rollback).className).toContain('olas-devtools-kind-rollback')
    expect(rollback.className).toBe('') // nothing to expand
    // An error with no recorded run has no duration.
    expect(orphan.querySelector('.olas-devtools-duration')).toBeNull()

    fireEvent.click(rowTop(run1))
    expect(run1.querySelector('.olas-devtools-payload-json')?.textContent).toBe('{id:1}')
    fireEvent.click(rowTop(success))
    expect(success.querySelector('.olas-devtools-payload-json')?.textContent).toBe('"ok"')
    fireEvent.click(rowTop(error))
    expect(error.querySelector('.olas-devtools-payload-json')?.textContent).toBe('"bad"')
  })

  test('a success with no recorded run shows no duration', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="mutations" />)
    bus.emit({ type: 'mutation:success', path: ['root'], name: 'save', result: 1 })
    expect(rows()[0]?.querySelector('.olas-devtools-duration')).toBeNull()
  })

  test('filters by kind, path, name, vars, result and error', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="mutations" />)
    bus.emit(
      { type: 'mutation:run', path: ['root'], name: 'save', vars: { title: 'draft' } },
      { type: 'mutation:success', path: ['root'], name: 'save', result: { id: 'srv-9' } },
      { type: 'mutation:error', path: ['root', 'cart'], error: 'out of stock' },
      { type: 'mutation:rollback', path: ['root', 'cart'] },
    )
    const kinds = () => rows().map((r) => kindOf(r).textContent)
    filter('draft')
    expect(kinds()).toEqual(['run'])
    filter('srv-9')
    expect(kinds()).toEqual(['success'])
    filter('stock')
    expect(kinds()).toEqual(['error'])
    filter('cart')
    expect(kinds()).toEqual(['rollback', 'error'])
    filter('nope')
    expect(body().textContent).toContain('Nothing matches “nope”.')
  })
})

describe('Fields log', () => {
  test('renders valid / invalid rows with the error list inline', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="fields" />)
    bus.emit(
      { type: 'field:validated', path: ['root', 'form'], field: 'email', valid: true, errors: [] },
      {
        type: 'field:validated',
        path: ['root', 'form'],
        field: 'name',
        valid: false,
        errors: ['Required', 'Too short'],
      },
    )
    const [invalid, valid] = rows() as [HTMLElement, HTMLElement]
    expect(kindOf(invalid).textContent).toBe('invalid')
    expect(kindOf(invalid).className).toContain('olas-devtools-kind-error')
    expect(invalid.querySelector('.olas-devtools-target')?.textContent).toBe('root › form · name')
    expect(invalid.querySelector('.olas-devtools-payload-inline')?.textContent).toBe(
      'Required · Too short',
    )
    expect(kindOf(valid).textContent).toBe('valid')
    expect(kindOf(valid).className).toContain('olas-devtools-kind-success')
    expect(valid.querySelector('.olas-devtools-payload-inline')).toBeNull()
  })

  test('filters by field, path, validity and error text', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="fields" />)
    bus.emit(
      {
        type: 'field:validated',
        path: ['root', 'signup'],
        field: 'email',
        valid: true,
        errors: [],
      },
      {
        type: 'field:validated',
        path: ['root', 'login'],
        field: 'password',
        valid: false,
        errors: ['Too weak'],
      },
    )
    const fields = () => rows().map((r) => r.querySelector('.olas-devtools-target')?.textContent)
    filter('invalid')
    expect(fields()).toEqual(['root › login · password'])
    filter('signup')
    expect(fields()).toEqual(['root › signup · email'])
    filter('weak')
    expect(fields()).toEqual(['root › login · password'])
    filter('zip')
    expect(body().textContent).toContain('Nothing matches “zip”.')
  })
})

describe('Cache inspector', () => {
  const entry = (over: Partial<DebugCacheEntry>): DebugCacheEntry => ({
    queryId: 'q',
    key: ['k'],
    status: 'success',
    data: undefined,
    error: undefined,
    lastUpdatedAt: undefined,
    isStale: false,
    isFetching: false,
    hasPendingMutations: false,
    ...over,
  })

  test('shows status colour, age and state tags per entry', () => {
    const bus = fakeRoot([
      entry({ key: ['ok'], status: 'success', lastUpdatedAt: NOW - 500, data: { n: 1 } }),
      entry({
        key: ['bad'],
        status: 'error',
        lastUpdatedAt: NOW - 5_000,
        error: 'boom',
        data: 'stale-data',
      }),
      entry({
        key: ['wait'],
        status: 'pending',
        lastUpdatedAt: NOW - 3 * 60_000,
        isFetching: true,
      }),
      entry({ key: ['old'], status: 'success', lastUpdatedAt: NOW - 2 * 3_600_000, isStale: true }),
      entry({ key: ['idle'], status: 'idle', hasPendingMutations: true }),
    ])
    render(<DevtoolsPanel root={bus.root} defaultTab="inspector" />)
    const byKey = (k: string) =>
      rows().find((r) => r.querySelector('.olas-devtools-target')?.textContent === k) as HTMLElement
    const suffix = (k: string) => byKey(k).querySelector('.olas-devtools-duration')?.textContent

    expect(kindOf(byKey('ok')).className).toContain('olas-devtools-kind-success')
    expect(kindOf(byKey('bad')).className).toContain('olas-devtools-kind-error')
    expect(kindOf(byKey('wait')).className).toContain('olas-devtools-kind-warn')
    expect(kindOf(byKey('idle')).className.trim()).toBe('olas-devtools-kind')

    expect(suffix('ok')).toBe('500ms ago')
    expect(suffix('bad')).toBe('5s ago')
    expect(suffix('wait')).toBe('3m ago · fetching')
    expect(suffix('old')).toBe('2h ago · stale')
    expect(suffix('idle')).toBe('— · optimistic')

    // The error is shown in preference to the data.
    fireEvent.click(rowTop(byKey('bad')))
    expect(byKey('bad').querySelector('.olas-devtools-payload-json')?.textContent).toBe('"boom"')
    // An entry with neither data nor error has nothing to expand.
    expect(byKey('idle').className).toBe('')
    const tab = screen.getByRole('tab', { name: 'Inspector' })
    expect(tab.querySelector('.olas-devtools-tab-count')?.textContent).toBe('5')
  })

  test('filters by key, status and data', () => {
    const bus = fakeRoot([
      entry({ key: ['user', 1], status: 'success', data: { name: 'Ada' } }),
      entry({ key: ['feed'], status: 'error', error: 'x' }),
    ])
    render(<DevtoolsPanel root={bus.root} defaultTab="inspector" />)
    const keys = () => rows().map((r) => r.querySelector('.olas-devtools-target')?.textContent)
    filter('ada')
    expect(keys()).toEqual(['user › 1'])
    filter('error')
    expect(keys()).toEqual(['feed'])
    filter('user')
    expect(keys()).toEqual(['user › 1'])
    filter('missing')
    expect(body().textContent).toContain('Nothing matches “missing”.')
  })

  test('refreshes from the bus on the next cache event, not on a timer', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="inspector" />)
    expect(body().textContent).toContain('No cache entries')
    bus.setEntries([entry({ key: ['late'], lastUpdatedAt: NOW })])
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(body().textContent).toContain('No cache entries') // no polling
    bus.emit({ type: 'cache:invalidated', queryKey: ['late'] })
    expect(rows()).toHaveLength(1)
  })
})
