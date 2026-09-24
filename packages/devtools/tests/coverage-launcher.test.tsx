// @vitest-environment jsdom

import type { DebugCacheEntry, DebugEvent } from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DevtoolsLauncher } from '../src/DevtoolsLauncher'

const KEY = 'olas-devtools-window'

/** A minimal `root.debug` bus that records how many subscribers are attached. */
function fakeRoot() {
  const handlers = new Set<(e: DebugEvent) => void>()
  return {
    handlers,
    root: {
      debug: {
        subscribe: (h: (e: DebugEvent) => void) => {
          handlers.add(h)
          return () => {
            handlers.delete(h)
          }
        },
        queryEntries: (): DebugCacheEntry[] => [],
      },
    },
  }
}

const launcher = () => screen.getByRole('button', { name: /Olas devtools$/ })
const dialog = () => screen.getByRole('dialog', { name: 'Olas devtools' })
const header = () => dialog().querySelector('.olas-devtools-floating-header') as HTMLElement
const persisted = (key = KEY) => JSON.parse(localStorage.getItem(key) ?? 'null')
const geometry = () => {
  const s = dialog().style
  return { left: s.left, top: s.top, width: s.width, height: s.height }
}
const setViewport = (w: number, h: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: w })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: h })
}

const originalCapture = Element.prototype.setPointerCapture

// On Node >= 25 the global `localStorage` is Node's own Web Storage, which is
// `undefined` without `--localstorage-file` and shadows jsdom's. Install jsdom's
// Storage explicitly so the persistence path runs on every Node version.
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const jsdomStorage = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window
  .localStorage

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: jsdomStorage,
  })
  vi.useFakeTimers()
  localStorage.clear()
  setViewport(1024, 768)
  // jsdom does not implement pointer capture; the launcher calls it on pointerdown.
  Element.prototype.setPointerCapture = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Element.prototype.setPointerCapture = originalCapture
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
})

describe('<DevtoolsLauncher> open / close', () => {
  test('starts closed with a "Show" button and persists the default window state', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    expect(launcher().getAttribute('aria-label')).toBe('Show Olas devtools')
    expect(launcher().className).not.toContain('olas-devtools-launcher-active')
    expect(screen.queryByRole('dialog')).toBeNull()
    // Default geometry: bottom-right, 16px margin, 56px above the bottom for the launcher.
    expect(persisted()).toEqual({ x: 488, y: 176, w: 520, h: 520, open: false, minimized: false })
  })

  test('the launcher button toggles the floating window and the panel inside it', () => {
    const { root, handlers } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())

    expect(dialog()).toBeTruthy()
    expect(screen.getByTestId('olas-devtools')).toBeTruthy()
    expect(launcher().getAttribute('aria-label')).toBe('Hide Olas devtools')
    expect(launcher().className).toContain('olas-devtools-launcher-active')
    expect(geometry()).toEqual({ left: '488px', top: '176px', width: '520px', height: '520px' })
    expect(handlers.size).toBe(1) // the panel attached to the root's bus
    expect(persisted().open).toBe(true)

    fireEvent.click(launcher())
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(handlers.size).toBe(0) // unmounting the panel detached it
    expect(persisted().open).toBe(false)
  })

  test('the Close button closes the window', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(launcher().getAttribute('aria-label')).toBe('Show Olas devtools')
  })

  test('Minimize collapses to the header, hides the panel and the resize grip; Expand restores', () => {
    const { root, handlers } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    expect(screen.getByRole('separator', { name: 'Resize' })).toBeTruthy()

    const minimize = screen.getByRole('button', { name: 'Minimize' })
    expect(minimize.textContent).toBe('–')
    fireEvent.click(minimize)

    expect(geometry().height).toBe('30px')
    expect(screen.queryByTestId('olas-devtools')).toBeNull()
    expect(screen.queryByRole('separator', { name: 'Resize' })).toBeNull()
    expect(handlers.size).toBe(0) // a minimized window holds no subscription
    const expand = screen.getByRole('button', { name: 'Expand' })
    expect(expand.textContent).toBe('▢')
    expect(persisted().minimized).toBe(true)

    fireEvent.click(expand)
    expect(geometry().height).toBe('520px')
    expect(screen.getByTestId('olas-devtools')).toBeTruthy()
    expect(persisted().minimized).toBe(false)
  })

  test('panel props are forwarded: defaultTab selects the initial tab', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} defaultTab="cache" maxEntries={5} />)
    fireEvent.click(launcher())
    expect(screen.getByRole('tab', { name: 'Cache' }).getAttribute('aria-selected')).toBe('true')
  })

  test('the window controls are native, focusable buttons (keyboard-operable)', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    for (const name of ['Hide Olas devtools', 'Minimize', 'Close']) {
      const button = screen.getByRole('button', { name })
      expect(button.tagName).toBe('BUTTON')
      expect(button.getAttribute('type')).toBe('button')
      button.focus()
      expect(document.activeElement).toBe(button)
    }
  })
})

describe('<DevtoolsLauncher> initial position and persistence', () => {
  test('`initial` sets the first position and size', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} initial={{ x: 40, y: 50, w: 400, h: 300 }} />)
    fireEvent.click(launcher())
    expect(geometry()).toEqual({ left: '40px', top: '50px', width: '400px', height: '300px' })
  })

  test('a partial `initial` derives the missing coordinates from the given size', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} initial={{ w: 400 }} />)
    fireEvent.click(launcher())
    // x = 1024 - 400 - 16; y keeps the default height's anchor.
    expect(geometry()).toEqual({ left: '608px', top: '176px', width: '400px', height: '520px' })
  })

  test('persisted state wins over `initial` and reopens the window where it was', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ x: 100, y: 120, w: 400, h: 300, open: true, minimized: true }),
    )
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} initial={{ x: 1, y: 1 }} />)
    expect(geometry()).toEqual({ left: '100px', top: '120px', width: '400px', height: '30px' })
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy()
  })

  test('missing persisted fields fall back to the defaults', () => {
    localStorage.setItem(KEY, JSON.stringify({ open: true }))
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    expect(geometry()).toEqual({ left: '488px', top: '176px', width: '520px', height: '520px' })
    expect(screen.getByRole('button', { name: 'Minimize' })).toBeTruthy()
  })

  test('an empty persisted object stays closed', () => {
    localStorage.setItem(KEY, '{}')
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('a persisted off-screen window is clamped back into the viewport on load', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ x: 5000, y: -50, w: 2000, h: 2000, open: true, minimized: false }),
    )
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    // w/h shrink to the viewport minus two margins; x/y pin to the margin.
    expect(geometry()).toEqual({ left: '16px', top: '16px', width: '992px', height: '736px' })
  })

  test('corrupt persisted JSON falls back to the defaults', () => {
    localStorage.setItem(KEY, '{not json')
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(persisted()).toEqual({ x: 488, y: 176, w: 520, h: 520, open: false, minimized: false })
  })

  test('storageKey isolates the persisted window state', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} storageKey="my-devtools" />)
    fireEvent.click(launcher())
    expect(persisted('my-devtools').open).toBe(true)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  test('a throwing setItem (quota, private mode) is swallowed', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    expect(dialog()).toBeTruthy()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  test('works without Web Storage at all: defaults, nothing persisted', () => {
    vi.stubGlobal('localStorage', undefined)
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(launcher())
    expect(geometry()).toEqual({ left: '488px', top: '176px', width: '520px', height: '520px' })
  })
})

describe('<DevtoolsLauncher> dragging, resizing and viewport clamping', () => {
  test('dragging the header moves the window; pointerup ends the drag', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())

    fireEvent.pointerDown(header(), { clientX: 500, clientY: 200, pointerId: 7 })
    expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(7)
    fireEvent.pointerMove(dialog(), { clientX: 400, clientY: 150 })
    expect(geometry()).toMatchObject({ left: '388px', top: '126px' })
    expect(persisted()).toMatchObject({ x: 388, y: 126 })

    fireEvent.pointerUp(dialog())
    fireEvent.pointerMove(dialog(), { clientX: 0, clientY: 0 })
    expect(geometry()).toMatchObject({ left: '388px', top: '126px' }) // no longer dragging
  })

  test('a pointer move without a preceding pointerdown does nothing', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    fireEvent.pointerMove(dialog(), { clientX: 10, clientY: 10 })
    expect(geometry()).toMatchObject({ left: '488px', top: '176px' })
  })

  test('dragging past the viewport edge clamps to the margin and keeps the header on screen', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    fireEvent.pointerDown(header(), { clientX: 500, clientY: 200, pointerId: 1 })
    fireEvent.pointerMove(dialog(), { clientX: -2000, clientY: -2000 })
    expect(geometry()).toMatchObject({ left: '16px', top: '16px' })
    fireEvent.pointerMove(dialog(), { clientX: 5000, clientY: 5000 })
    // x stops where the right edge meets the margin; y stops with the 30px header visible.
    expect(geometry()).toMatchObject({ left: '488px', top: '722px' })
  })

  test('the resize grip resizes with a minimum size; pointercancel ends the resize', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    const grip = screen.getByRole('separator', { name: 'Resize' })

    fireEvent.pointerDown(grip, { clientX: 0, clientY: 0, pointerId: 2 })
    fireEvent.pointerMove(dialog(), { clientX: -300, clientY: -300 })
    expect(geometry()).toMatchObject({ width: '360px', height: '280px' }) // MIN_W / MIN_H

    fireEvent.pointerMove(dialog(), { clientX: 100, clientY: 50 })
    // Growing past the right edge shifts the window left to stay in view.
    expect(geometry()).toEqual({ left: '388px', top: '176px', width: '620px', height: '570px' })

    fireEvent.pointerCancel(dialog())
    fireEvent.pointerMove(dialog(), { clientX: 300, clientY: 300 })
    expect(geometry()).toMatchObject({ width: '620px', height: '570px' })
  })

  test('a window resize re-clamps the floating window to the new viewport', () => {
    const { root } = fakeRoot()
    render(<DevtoolsLauncher root={root} />)
    fireEvent.click(launcher())
    setViewport(600, 500)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(geometry()).toEqual({ left: '64px', top: '176px', width: '520px', height: '468px' })
  })

  test('unmounting removes the window resize listener', () => {
    const { root } = fakeRoot()
    const { unmount } = render(<DevtoolsLauncher root={root} />)
    const removed = vi.spyOn(window, 'removeEventListener')
    unmount()
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function))
  })
})
