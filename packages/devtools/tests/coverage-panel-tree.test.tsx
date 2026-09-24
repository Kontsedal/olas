// @vitest-environment jsdom

import { type DebugEvent, signal } from '@kontsedal/olas-core'
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

const constructed = (path: string[], props?: unknown, debug?: Record<string, unknown>) =>
  ({
    type: 'controller:constructed',
    path,
    props,
    ...(debug ? { debug } : {}),
  }) as DebugEvent
const body = () => screen.getByRole('tabpanel')
/** The row (name + state + badges) of the tree node whose name is `name`. */
const nodeRow = (name: string) =>
  screen.getByText(name, { selector: '.olas-devtools-tree-name' }).parentElement as HTMLElement
const propsButton = (name: string) =>
  nodeRow(name).querySelector('.olas-devtools-tree-props-toggle') as HTMLButtonElement | null

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Tree view', () => {
  test('shows an empty state before any controller is constructed, and hides the filter', () => {
    render(<DevtoolsPanel root={fakeRoot().root} defaultTab="tree" />)
    expect(body().textContent).toContain('No controllers yet')
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  test('nests children and styles each lifecycle state', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(
      constructed(['root']),
      constructed(['root', 'a']),
      constructed(['root', 'b']),
      { type: 'controller:suspended', path: ['root', 'a'] },
      { type: 'controller:disposed', path: ['root', 'b'] },
    )
    expect(nodeRow('root').textContent).toContain('active')
    expect(nodeRow('a').querySelector('.olas-devtools-tree-state-suspended')?.textContent).toBe(
      'suspended',
    )
    expect(nodeRow('b').querySelector('.olas-devtools-tree-state-disposed')?.textContent).toBe(
      'disposed',
    )
    // The tree renders flat, one windowed row per node; nesting is the level.
    const level = (name: string) =>
      nodeRow(name).closest('[role="treeitem"]')?.getAttribute('aria-level')
    expect(level('root')).toBe('1')
    expect(level('a')).toBe('2')
    expect(level('b')).toBe('2')
  })

  test('counts in-flight mutations per controller until they settle', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    const run = (name: string): DebugEvent => ({
      type: 'mutation:run',
      path: ['root'],
      name,
      vars: 1,
    })
    bus.emit(constructed(['root']), constructed(['root', 'child']), run('save'), run('save'))
    expect(nodeRow('root').textContent).toContain('2 pending')
    expect(nodeRow('child').textContent).not.toContain('pending')

    bus.emit({ type: 'mutation:rollback', path: ['root'], name: 'save' })
    expect(nodeRow('root').textContent).toContain('2 pending') // a rollback is not a settle

    bus.emit({ type: 'mutation:success', path: ['root'], name: 'save', result: 1 })
    expect(nodeRow('root').textContent).toContain('1 pending')

    bus.emit({ type: 'mutation:error', path: ['root'], name: 'save', error: 'x' })
    expect(nodeRow('root').textContent).not.toContain('pending')
  })

  test('a settle with no recorded run never drives the count below zero', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root']), { type: 'mutation:success', path: ['root'], result: 1 })
    expect(nodeRow('root').textContent).not.toContain('pending')
    bus.emit({ type: 'mutation:run', path: ['root'], vars: 1 })
    expect(nodeRow('root').textContent).toContain('1 pending')
  })
})

describe('Tree ctx.debug variables', () => {
  test('lists signals live, functions as [fn], and plain values as JSON', () => {
    const count = signal(1)
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(
      constructed(['root'], undefined, {
        count,
        onSave: function onSave() {},
        anon: [() => {}][0],
        cfg: { a: 1 },
      }),
    )
    const vars = body().querySelector('.olas-devtools-tree-vars') as HTMLElement
    const value = (name: string) =>
      [...vars.querySelectorAll('.olas-devtools-var-row')]
        .find((r) => r.querySelector('.olas-devtools-var-name')?.textContent === `${name}:`)
        ?.textContent?.slice(name.length + 1)
    expect(value('count')).toBe('1')
    expect(value('onSave')).toBe('[fn onSave]')
    expect(value('anon')).toBe('[fn]')
    expect(value('cfg')).toBe('{a:1}')

    act(() => count.set(5))
    expect(value('count')).toBe('5')
  })

  test('the vars toggle hides and shows the variables; its label pluralizes', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(
      constructed(['root'], undefined, { a: 1, b: 2 }),
      constructed(['root', 'one'], undefined, { x: 1 }),
    )
    expect(screen.getByRole('button', { name: '1 var' })).toBeTruthy()
    const toggle = screen.getByRole('button', { name: '2 vars' })
    expect(toggle.getAttribute('title')).toBe('Hide variables')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.getAttribute('title')).toBe('Show variables')
    expect(body().querySelectorAll('.olas-devtools-tree-vars')).toHaveLength(1) // only `one`'s

    fireEvent.click(toggle)
    expect(body().querySelectorAll('.olas-devtools-tree-vars')).toHaveLength(2)
  })

  test('a post-construction controller:debug update adds the variables section', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root']))
    expect(body().querySelector('.olas-devtools-tree-vars')).toBeNull()
    bus.emit({ type: 'controller:debug', path: ['root'], values: { late: 'yes' } })
    expect(body().querySelector('.olas-devtools-tree-vars')?.textContent).toBe('late:"yes"')
  })
})

describe('Tree props summary', () => {
  test.each([
    ['a short string', 'hello', '"hello"'],
    ['a long string, truncated at 24', 'abcdefghijklmnopqrstuvwxyz', '"abcdefghijklmnopqrstuvw…"'],
    ['a number', 42, '42'],
    ['a boolean', true, 'true'],
    ['an array, by length', [1, 2, 3], '[3]'],
    ['an empty object', {}, '{}'],
    ['a bigint', 7n, '7'],
    [
      'an object: first two keys, then a count',
      { id: 1, title: 'a very long title indeed', extra: true },
      '{ id: 1, title: "a very long tit…", +1 }',
    ],
    ['nested value shapes', { a: null, b: undefined }, '{ a: null, b: undefined }'],
    ['nested collections', { list: [1, 2], obj: { x: 1, y: 2 } }, '{ list: [2], obj: {2} }'],
    ['nested scalars', { ok: false, n: 5n }, '{ ok: false, n: 5 }'],
  ])('summarizes %s', (_label, props, summary) => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root'], props))
    expect(propsButton('root')?.textContent).toBe(summary)
  })

  test.each([
    ['undefined', undefined],
    ['null', null],
  ])('%s props show no props toggle', (_label, props) => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root'], props))
    expect(propsButton('root')).toBeNull()
  })

  test('the props toggle expands the full props as JSON and collapses them again', () => {
    const bus = fakeRoot()
    render(<DevtoolsPanel root={bus.root} defaultTab="tree" />)
    bus.emit(constructed(['root'], { id: 1 }))
    const toggle = propsButton('root') as HTMLButtonElement
    expect(toggle.getAttribute('title')).toBe('Show full props')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('title')).toBe('Hide props')
    expect(body().querySelector('.olas-devtools-tree-props')?.textContent).toBe('{id:1}')
    fireEvent.click(toggle)
    expect(body().querySelector('.olas-devtools-tree-props')).toBeNull()
  })
})
