// @vitest-environment jsdom

import type { DebugEvent } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsPanel } from '../src/DevtoolsPanel'

/** A `root.debug` bus the test drives by hand. */
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

const body = () => screen.getByRole('tabpanel')
const filter = (value: string) =>
  act(() => {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value } })
    vi.advanceTimersByTime(150) // past the filter debounce
  })
const badge = (label: string) =>
  screen.getAllByText(label, { selector: '.olas-devtools-kind' })[0] as HTMLElement
const rowOf = (label: string) => badge(label).parentElement as HTMLElement
const groupHead = () => body().querySelector('.olas-devtools-tl-group-head') as HTMLElement

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Timeline rows', () => {
  test('an empty timeline shows the empty state', () => {
    render(<DevtoolsPanel root={fakeRoot().root} />)
    expect(body().textContent).toContain('No events yet')
  })

  test('each event gets a short badge, a target and a colour class for its outcome', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      { type: 'controller:suspended', path: ['root', 'list'] },
      { type: 'cache:gc', queryKey: ['u', 1] },
      { type: 'cache:fetch-error', queryKey: ['u', 2], error: 'x', durationMs: 1 },
      { type: 'snapshot:rollback', queryKey: ['u', 3] },
      { type: 'snapshot:push', queryKey: ['u', 4] },
      { type: 'field:validated', path: ['root', 'form'], field: 'email', valid: true, errors: [] },
      { type: 'mutation:success', path: ['root'], result: 1 },
    )
    expect(badge('suspended').className).toContain('olas-devtools-kind-warn')
    expect(rowOf('suspended').textContent).toContain('root › list')
    expect(badge('gc').className).toContain('olas-devtools-kind-warn')
    expect(badge('fetch-error').className).toContain('olas-devtools-kind-error')
    expect(badge('snap:rollback').className).toContain('olas-devtools-kind-rollback')
    expect(badge('snap:push').className.trim()).toBe('olas-devtools-kind') // no outcome colour
    expect(rowOf('validated').textContent).toContain('root › form · email')
    // An unnamed mutation's target is just its controller path.
    expect(badge('success').className).toContain('olas-devtools-kind-success')
    expect(rowOf('success').querySelector('.olas-devtools-target')?.textContent).toBe('root')
  })

  test('rows render newest first', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      { type: 'cache:invalidated', queryKey: ['first'] },
      { type: 'cache:invalidated', queryKey: ['second'] },
    )
    const targets = [...body().querySelectorAll('.olas-devtools-target')].map((n) => n.textContent)
    expect(targets).toEqual(['second', 'first'])
  })

  test('a plugin event is badged with its plugin name and shows its payload as the target', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit({ type: 'plugin:event', plugin: 'persist', payload: { restored: 3 } })
    expect(rowOf('persist').querySelector('.olas-devtools-target')?.textContent).toBe('restored:3')
  })

  test('clicking a row with a payload expands it to JSON; clicking again collapses', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit({ type: 'mutation:run', path: ['root'], name: 'save', vars: { id: 7 } })
    const row = rowOf('run')
    expect(row.querySelector('.olas-devtools-chevron')).toBeTruthy()
    expect(body().querySelector('.olas-devtools-payload-json')).toBeNull()

    fireEvent.click(row)
    expect(body().querySelector('.olas-devtools-payload-json')?.textContent).toBe('{id:7}')
    expect(row.querySelector('.olas-devtools-chevron-open')).toBeTruthy()

    fireEvent.click(row)
    expect(body().querySelector('.olas-devtools-payload-json')).toBeNull()
  })

  test('a row without a payload has no chevron and does not expand', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit({ type: 'snapshot:push', queryKey: ['k'] })
    const row = rowOf('snap:push')
    expect(row.querySelector('.olas-devtools-chevron')).toBeNull()
    fireEvent.click(row)
    expect(body().querySelector('.olas-devtools-payload')).toBeNull()
  })
})

describe('Timeline cause groups', () => {
  test('a fetch chain groups under its first event, with +Δms offsets and an ok accent', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      { type: 'cache:fetch-start', queryKey: ['u', 1], causeId: 'f1', t: 1000 },
      {
        type: 'cache:set-data',
        queryKey: ['u', 1],
        source: 'fetch',
        data: 1,
        causeId: 'f1',
        t: 1005,
      },
      { type: 'cache:fetch-success', queryKey: ['u', 1], durationMs: 12, causeId: 'f1', t: 1012 },
    )
    const group = body().querySelector('.olas-devtools-tl-group') as HTMLElement
    expect(group.className).toContain('olas-devtools-tl-group-ok')
    expect(group.querySelector('.olas-devtools-tl-group-title')?.textContent).toBe(
      'fetch-start · u › 1',
    )
    expect(group.querySelector('.olas-devtools-tl-group-count')?.textContent).toBe('3')
    const deltas = [...group.querySelectorAll('.olas-devtools-tl-delta')].map((n) => n.textContent)
    expect(deltas).toEqual(['+5ms', '+12ms']) // the first event (Δ 0) shows none
  })

  test('the group head collapses and re-expands the chain', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      { type: 'mutation:run', path: ['root'], name: 'save', vars: 1, causeId: 'r1' },
      { type: 'mutation:success', path: ['root'], name: 'save', result: 1, causeId: 'r1' },
    )
    expect(groupHead().getAttribute('aria-expanded')).toBe('true')
    expect(groupHead().textContent).toContain('save · root') // titled by the mutation
    fireEvent.click(groupHead())
    expect(groupHead().getAttribute('aria-expanded')).toBe('false')
    expect(body().querySelector('.olas-devtools-tl-group-body')).toBeNull()
    expect(groupHead().querySelector('.olas-devtools-chevron-open')).toBeNull()
    fireEvent.click(groupHead())
    expect(body().querySelector('.olas-devtools-tl-group-body')).toBeTruthy()
  })

  test('a group of more than 12 events starts collapsed', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      ...Array.from(
        { length: 13 },
        (): DebugEvent => ({ type: 'snapshot:push', queryKey: ['k'], causeId: 'big' }),
      ),
    )
    expect(groupHead().getAttribute('aria-expanded')).toBe('false')
    expect(groupHead().textContent).toContain('13')
  })

  test.each([
    ['rollback', [{ type: 'snapshot:rollback', queryKey: ['k'], causeId: 'c' }]],
    ['active', [{ type: 'snapshot:push', queryKey: ['k'], causeId: 'c' }]],
    ['error', [{ type: 'mutation:error', path: ['root'], error: 'x', causeId: 'c' }]],
  ] as Array<
    [string, DebugEvent[]]
  >)('a group whose worst outcome is %s gets that accent', (status, events) => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(...events)
    expect(body().querySelector('.olas-devtools-tl-group')?.className).toContain(
      `olas-devtools-tl-group-${status}`,
    )
  })
})

describe('Timeline cache:set-data detail', () => {
  const write = (data: unknown, source: 'fetch' | 'write' = 'write'): DebugEvent => ({
    type: 'cache:set-data',
    queryKey: ['u'],
    source,
    data,
  })
  const expandNewestWrite = () => fireEvent.click(rowOf('set-data'))

  test('the first write to a key shows its source and the whole value (nothing to diff)', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(write({ name: 'Ada' }, 'fetch'))
    expandNewestWrite()
    const detail = body().querySelector('.olas-devtools-payload-json') as HTMLElement
    expect(detail.querySelector('.olas-devtools-tl-source')?.textContent).toBe('source: fetch')
    expect(detail.textContent).toContain('name:"Ada"')
    expect(detail.querySelector('.olas-devtools-diff-change')).toBeNull()
  })

  test('a write with identical content reads "no change"', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(write({ a: 1 }), write({ a: 1 }))
    expandNewestWrite()
    expect(body().querySelector('.olas-devtools-payload-json')?.textContent).toContain('no change')
  })

  test('added and removed keys render with + / − marks', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(write({ keep: 1, gone: 'old' }), write({ keep: 1, fresh: 'new' }))
    expandNewestWrite()
    const detail = body().querySelector('.olas-devtools-payload-json') as HTMLElement
    expect(detail.querySelector('.olas-devtools-diff-add')?.textContent).toBe('+"new"')
    expect(detail.querySelector('.olas-devtools-diff-remove')?.textContent).toBe('−"old"')
    expect(detail.querySelector('.olas-devtools-diff-unchanged')?.textContent).toBe('+1 unchanged')
  })

  test('an array diff renders in square brackets with only the changed index', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(write([1, 2]), write([1, 3]))
    expandNewestWrite()
    const block = body().querySelector('.olas-devtools-diff-block') as HTMLElement
    expect(block.firstElementChild?.textContent).toBe('[')
    expect(block.lastElementChild?.textContent).toBe(']')
    expect(block.querySelector('.olas-devtools-diff-row')?.textContent).toBe('1:2→3')
  })
})

describe('Timeline filter', () => {
  test('matches on type, target, causeId, set-data source/content and payload', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    bus.emit(
      { type: 'mutation:run', path: ['root'], name: 'save', vars: { title: 'hello' } },
      { type: 'cache:set-data', queryKey: ['posts'], source: 'optimistic', data: { title: 'Ada' } },
      { type: 'cache:set-data', queryKey: ['empty'], source: 'write', data: undefined },
      { type: 'snapshot:push', queryKey: ['posts'], causeId: 'run-42' },
    )
    filter('hello')
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(1)
    expect(rowOf('run')).toBeTruthy()

    filter('ada') // set-data content, case-insensitive
    expect(body().textContent).toContain('posts')
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(1)

    filter('optimistic') // set-data source
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(1)

    filter('run-42') // causeId
    expect(body().querySelector('.olas-devtools-tl-group')).toBeTruthy()

    filter('empty') // a write whose data serializes to nothing still matches by key
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(1)

    filter('zzz')
    expect(body().textContent).toContain('Nothing matches “zzz”.')
  })

  test('a circular payload does not break filtering', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} />)
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    bus.emit({ type: 'cache:set-data', queryKey: ['cyc'], source: 'write', data: cyclic })
    filter('cyc')
    expect(body().querySelectorAll('.olas-devtools-tl-row')).toHaveLength(1)
  })
})
