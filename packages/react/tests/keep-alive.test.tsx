// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { type SuspendableController, SuspendOnUnmount, useSuspendOnHidden } from '../src'

afterEach(() => {
  cleanup()
})

const makeController = (): SuspendableController & {
  suspendCalls: number
  resumeCalls: number
} => {
  let s = 0
  let r = 0
  return {
    suspend() {
      s += 1
    },
    resume() {
      r += 1
    },
    get suspendCalls() {
      return s
    },
    get resumeCalls() {
      return r
    },
  }
}

describe('SuspendOnUnmount', () => {
  test('mount calls resume, unmount calls suspend', () => {
    const c = makeController()
    const { unmount } = render(
      <SuspendOnUnmount controller={c}>
        <div>child</div>
      </SuspendOnUnmount>,
    )
    expect(c.resumeCalls).toBe(1)
    expect(c.suspendCalls).toBe(0)

    unmount()
    expect(c.suspendCalls).toBe(1)
  })

  test('swapping controllers suspends the old one and resumes the new', () => {
    const a = makeController()
    const b = makeController()

    function Switcher() {
      const [which, setWhich] = useState<SuspendableController>(a)
      return (
        <>
          <button type="button" onClick={() => setWhich(b)} data-testid="swap">
            swap
          </button>
          <SuspendOnUnmount controller={which}>
            <div>x</div>
          </SuspendOnUnmount>
        </>
      )
    }

    const r = render(<Switcher />)
    expect(a.resumeCalls).toBe(1)
    expect(b.resumeCalls).toBe(0)

    act(() => {
      r.getByTestId('swap').click()
    })
    expect(a.suspendCalls).toBe(1)
    expect(b.resumeCalls).toBe(1)
  })
})

describe('useSuspendOnHidden', () => {
  test('suspends on visibilitychange→hidden, resumes on →visible', () => {
    const c = makeController()
    function Probe() {
      useSuspendOnHidden(c)
      return null
    }
    render(<Probe />)
    // Initial mount: no visibility change yet — neither called.
    expect(c.suspendCalls).toBe(0)
    expect(c.resumeCalls).toBe(0)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(c.suspendCalls).toBe(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(c.resumeCalls).toBe(1)
  })

  test('removes its listener on unmount', () => {
    const c = makeController()
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    function Probe() {
      useSuspendOnHidden(c)
      return null
    }
    const { unmount } = render(<Probe />)
    expect(addSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  test('unmounting while hidden resumes instead of stranding the controller', () => {
    // Nothing else is listening for `visibilitychange` once this effect is
    // gone, so a controller left suspended here stays suspended forever.
    const c = makeController()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })

    function Probe() {
      useSuspendOnHidden(c)
      return null
    }
    const { unmount } = render(<Probe />)
    expect(c.suspendCalls).toBe(1)
    expect(c.resumeCalls).toBe(0)

    act(() => unmount())
    expect(c.resumeCalls).toBe(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  test('unmounting while visible leaves the controller alone', () => {
    // The hook never resumed a visible controller on mount, so it has
    // nothing to undo on unmount either — the caller owns that state.
    const c = makeController()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })

    function Probe() {
      useSuspendOnHidden(c)
      return null
    }
    const { unmount } = render(<Probe />)
    act(() => unmount())
    expect(c.suspendCalls).toBe(0)
    expect(c.resumeCalls).toBe(0)
  })

  test('swapping the controller while hidden resumes the one being dropped', () => {
    const a = makeController()
    const b = makeController()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })

    function Probe({ controller }: { controller: SuspendableController }) {
      useSuspendOnHidden(controller)
      return null
    }
    const { rerender } = render(<Probe controller={a} />)
    expect(a.suspendCalls).toBe(1)

    act(() => rerender(<Probe controller={b} />))
    expect(a.resumeCalls).toBe(1) // handed back, not stranded
    expect(b.suspendCalls).toBe(1)

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })
})

// R4.6 (T4.6) — cross-fade overlap: two wrappers around the SAME controller must
// refcount so the exiting screen's unmount doesn't suspend a controller the
// entering screen is still using.
describe('SuspendOnUnmount refcounting (R4.6)', () => {
  test('overlapping consumers keep the controller resumed until the LAST unmounts', () => {
    let resumed = false
    const controller: SuspendableController = {
      resume() {
        resumed = true
      },
      suspend() {
        resumed = false
      },
    }
    function Harness({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          {a && (
            <SuspendOnUnmount controller={controller}>
              <div />
            </SuspendOnUnmount>
          )}
          {b && (
            <SuspendOnUnmount controller={controller}>
              <div />
            </SuspendOnUnmount>
          )}
        </>
      )
    }
    const { rerender } = render(<Harness a b={false} />)
    expect(resumed).toBe(true)

    // Cross-fade: B enters (overlaps A), then A exits.
    rerender(<Harness a b />)
    expect(resumed).toBe(true)
    rerender(<Harness a={false} b />)
    // The bug: A's cleanup suspended a controller B is still mounted on.
    expect(resumed).toBe(true)

    // Only when the LAST consumer unmounts does it suspend.
    rerender(<Harness a={false} b={false} />)
    expect(resumed).toBe(false)
  })
})
