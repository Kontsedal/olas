// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KeepAlive, type SuspendableController, useSuspendOnHidden } from '../src'

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

describe('KeepAlive', () => {
  test('mount calls resume, unmount calls suspend', () => {
    const c = makeController()
    const { unmount } = render(
      <KeepAlive controller={c}>
        <div>child</div>
      </KeepAlive>,
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
          <KeepAlive controller={which}>
            <div>x</div>
          </KeepAlive>
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
})
