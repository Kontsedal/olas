// @vitest-environment jsdom
//
// Verify that `useSuspendOnHidden` calls `suspend` / `resume` in response to
// document `visibilitychange` events. We pass a tiny fake controller so we
// can spy on the method calls without spinning up a real root.

import { describe, expect, test, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSuspendOnHidden, type SuspendableController } from '@olas/react'

function Probe({ controller }: { controller: SuspendableController }) {
  useSuspendOnHidden(controller)
  return null
}

describe('useSuspendOnHidden', () => {
  test('suspends on visibilitychange → hidden, resumes on visible', () => {
    const controller: SuspendableController = {
      suspend: vi.fn(),
      resume: vi.fn(),
    }
    render(<Probe controller={controller} />)

    // Initially visible — visibilitychange has not fired, so nothing is called.
    expect(controller.suspend).not.toHaveBeenCalled()
    expect(controller.resume).not.toHaveBeenCalled()

    // Hide.
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(controller.suspend).toHaveBeenCalledTimes(1)

    // Show.
    act(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(controller.resume).toHaveBeenCalledTimes(1)
  })
})
