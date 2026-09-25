// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { VirtualList } from '../src/virtual'

// jsdom lays nothing out and has no ResizeObserver, so the panel tests only
// ever see estimated sizes. These stubs give rows a real height (from their
// `data-h` attribute) and the scroller a 200px viewport, which exercises the
// measurement path a browser takes.

type Observer = { cb: () => void; targets: Element[] }
let observers: Observer[] = []

function layout(): void {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const h = Number(this.getAttribute('data-h') ?? 0)
    let top = 0
    for (let s = this.previousElementSibling; s !== null; s = s.previousElementSibling) {
      top += Number(s.getAttribute('data-h') ?? 0)
    }
    return { top, height: h, bottom: top + h, left: 0, right: 0, width: 0, x: 0, y: top } as DOMRect
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('olas-devtools-vlist') ? 200 : 0
    },
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly o: Observer
      constructor(cb: () => void) {
        this.o = { cb, targets: [] }
        observers.push(this.o)
      }
      observe(el: Element) {
        this.o.targets.push(el)
      }
      disconnect() {
        this.o.targets = []
      }
    },
  )
}

const heights = new Map<number, number>()
function List(props: { count?: number; scrollToIndex?: number; scrollNonce?: number }) {
  return (
    <VirtualList
      count={props.count ?? 1000}
      estimate={() => 20}
      getKey={(i) => `r${i}`}
      renderRow={(i) => (
        <div data-h={heights.get(i) ?? 40} data-testid="row">
          row {i}
        </div>
      )}
      label="rows"
      overscan={2}
      {...(props.scrollToIndex !== undefined ? { scrollToIndex: props.scrollToIndex } : {})}
      {...(props.scrollNonce !== undefined ? { scrollNonce: props.scrollNonce } : {})}
    />
  )
}
const rows = () => screen.getAllByTestId('row').map((r) => r.textContent)
const inner = () => screen.getByLabelText('rows') as HTMLElement

beforeEach(() => {
  observers = []
  heights.clear()
  layout()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
})

describe('VirtualList with real layout', () => {
  test('measures mounted rows and re-windows on their real size', () => {
    render(<List />)
    // The first pass windows on the 600px fallback viewport and the 20px
    // estimate, so it mounts rows 0-32. They measure 40px, and the scroller
    // measures 200px, so the second pass needs rows 0-5, + 2 overscan.
    expect(rows()).toEqual(['row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6', 'row 7'])
    // Rows 8-32 were measured (40px) but are no longer mounted; the rest are estimates.
    expect(inner().style.paddingBottom).toBe(`${25 * 40 + 967 * 20}px`)
  })

  test('a row that changes size after mount is re-measured through ResizeObserver', () => {
    render(<List />)
    const before = inner().style.paddingBottom
    heights.set(0, 400)
    screen.getAllByTestId('row')[0]?.setAttribute('data-h', '400')
    act(() => {
      for (const o of observers) o.cb()
    })
    // Row 0 now fills the viewport on its own, so fewer rows are mounted.
    expect(rows()).toEqual(['row 0', 'row 1', 'row 2'])
    expect(inner().style.paddingBottom).not.toBe(before)
  })

  test('a ResizeObserver callback with no size change does not re-render', () => {
    render(<List />)
    const first = screen.getAllByTestId('row')[0]
    act(() => {
      for (const o of observers) o.cb()
    })
    expect(screen.getAllByTestId('row')[0]).toBe(first)
  })

  test('scrollToIndex jumps once per nonce', () => {
    const { rerender } = render(<List scrollToIndex={500} scrollNonce={1} />)
    expect(rows()).toContain('row 500')
    // The user scrolls back to the top; the same nonce does not pull them away again.
    const scroller = inner().parentElement as HTMLElement
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: 0 })
    fireEvent.scroll(scroller)
    rerender(<List scrollToIndex={500} scrollNonce={1} />)
    expect(rows()).toContain('row 0')
    rerender(<List scrollToIndex={900} scrollNonce={2} />)
    expect(rows()).toContain('row 900')
  })

  test('an index that is not there yet (-1) waits for it', () => {
    const { rerender } = render(<List scrollToIndex={-1} scrollNonce={1} />)
    expect(rows()).toContain('row 0')
    rerender(<List scrollToIndex={700} scrollNonce={1} />)
    expect(rows()).toContain('row 700')
  })

  test('the viewport follows the scroller’s size', () => {
    render(<List />)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('olas-devtools-vlist') ? 400 : 0
      },
    })
    act(() => {
      for (const o of observers) o.cb()
    })
    expect(rows().length).toBeGreaterThan(7)
  })

  test('an empty list renders an empty container', () => {
    render(<List count={0} />)
    expect(screen.queryAllByTestId('row')).toEqual([])
    expect(inner().style.paddingTop).toBe('0px')
  })
})
