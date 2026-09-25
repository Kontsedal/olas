// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { JsonView } from '../src/JsonView'

afterEach(() => cleanup())

const text = (value: unknown, depth?: number) =>
  render(<JsonView value={value} depth={depth} />).container.textContent

describe('JsonView scalars and built-ins', () => {
  test.each([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['a string, quoted', 'hi', '"hi"'],
    ['a number', 42, '42'],
    ['a boolean', false, 'false'],
    ['a bigint, with the n suffix', 10n, '10n'],
    ['a symbol', Symbol('tag'), 'Symbol(tag)'],
    ['a named function', function greet() {}, '[fn greet]'],
    ['an anonymous function', [() => {}][0], '[fn]'],
    ['an Error, as Name("message")', new TypeError('bad "x"'), 'TypeError("bad \\"x\\"")'],
    ['a Date, as ISO', new Date(Date.UTC(2020, 0, 2)), '2020-01-02T00:00:00.000Z'],
    ['a RegExp', /a+/gi, '/a+/gi'],
    [
      'a Map, by size',
      new Map([
        [1, 1],
        [2, 2],
      ]),
      'Map(2)',
    ],
    ['a Set, by size', new Set([1, 2, 3]), 'Set(3)'],
    ['a typed array, by length', new Uint8Array(4), 'Uint8Array(4)'],
    ['a DataView (no length), as 0', new DataView(new ArrayBuffer(8)), 'DataView(0)'],
  ])('renders %s', (_label, value, expected) => {
    expect(text(value)).toBe(expected)
  })
})

describe('JsonView arrays', () => {
  test('an empty array renders as []', () => {
    expect(text([])).toBe('[]')
  })

  test('a short root array starts open; the bracket collapses and re-expands it', () => {
    render(<JsonView value={['a', 'b']} />)
    const collapse = screen.getByRole('button', { name: 'Collapse array of 2 items' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')
    expect(document.body.textContent).toBe('[0:"a"1:"b"]')

    fireEvent.click(collapse)
    const expand = screen.getByRole('button', { expanded: false })
    expect(expand.textContent).toBe('[2 items]')

    fireEvent.click(expand)
    expect(document.body.textContent).toBe('[0:"a"1:"b"]')
  })

  test('a one-item array uses the singular label', () => {
    render(<JsonView value={[1]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse array of 1 item' }))
    expect(screen.getByRole('button', { expanded: false }).textContent).toBe('[1 item]')
  })

  test('a root array longer than 12 items starts collapsed', () => {
    expect(text(Array.from({ length: 13 }, (_, i) => i))).toBe('[13 items]')
  })

  test('a nested array starts collapsed and expands on click', () => {
    render(<JsonView value={{ list: [1, 2, 3] }} />)
    const nested = screen.getByRole('button', { expanded: false })
    expect(nested.textContent).toBe('[3 items]')
    fireEvent.click(nested)
    expect(screen.getByRole('button', { name: 'Collapse array of 3 items' })).toBeTruthy()
    expect(document.body.textContent).toContain('0:11:22:3')
  })

  test('an array that contains itself shows [Circular] instead of recursing', () => {
    const arr: unknown[] = ['x']
    arr.push(arr)
    expect(text(arr)).toBe('[0:"x"1:[Circular]]')
  })
})

describe('JsonView objects', () => {
  test('an empty object renders as {}', () => {
    expect(text({})).toBe('{}')
  })

  test('a small root object starts open; collapsing shows its key summary', () => {
    render(<JsonView value={{ only: 1 }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse object with 1 key' }))
    expect(screen.getByRole('button', { expanded: false }).textContent).toBe('{only}')
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(document.body.textContent).toBe('{only:1}')
  })

  test('a root object with more than 8 keys starts collapsed, summarizing 3 keys + the rest', () => {
    const wide = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]))
    expect(text(wide)).toBe('{k0, k1, k2 +6}')
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('button', { name: 'Collapse object with 9 keys' })).toBeTruthy()
  })

  test('a non-zero depth starts collapsed even for a small value', () => {
    expect(text({ a: 1, b: 2 }, 1)).toBe('{a, b}')
  })
})
