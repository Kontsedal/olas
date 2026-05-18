import { effect, signal } from '../signals'
import type { ReadSignal } from '../signals/types'

/**
 * Rate-limit a signal so it emits at most once per `ms` (leading + trailing).
 * The first change passes through immediately. Subsequent changes within the
 * window are coalesced; the latest value is emitted when the window expires.
 *
 * No lifecycle — see debounced() note.
 */
export function throttled<T>(source: ReadSignal<T>, ms: number): ReadSignal<T> {
  const out = signal<T>(source.peek())
  let lastEmit = Number.NEGATIVE_INFINITY
  let trailingTimer: ReturnType<typeof setTimeout> | null = null
  let trailingValue: T = source.peek()
  let initial = true

  effect(() => {
    const value = source.value
    if (initial) {
      initial = false
      return
    }
    const now = Date.now()
    const elapsed = now - lastEmit
    if (elapsed >= ms) {
      out.set(value)
      lastEmit = now
      if (trailingTimer != null) {
        clearTimeout(trailingTimer)
        trailingTimer = null
      }
    } else {
      trailingValue = value
      if (trailingTimer == null) {
        trailingTimer = setTimeout(() => {
          out.set(trailingValue)
          lastEmit = Date.now()
          trailingTimer = null
        }, ms - elapsed)
      }
    }
  })

  return out
}
