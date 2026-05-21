import { effect, signal } from '../signals'
import type { ReadSignal } from '../signals/types'

/**
 * Rate-limit a signal so it emits at most once per `ms` (leading + trailing).
 * The first change passes through immediately. Subsequent changes within the
 * window are coalesced; the latest value is emitted when the window expires.
 *
 * Pass `options.signal` to tie the internal effect to a lifecycle — when the
 * signal aborts the effect disposes and any pending trailing timer clears.
 * Without `signal`, the effect lives as long as `source` does.
 */
export function throttled<T>(
  source: ReadSignal<T>,
  ms: number,
  options?: { signal?: AbortSignal },
): ReadSignal<T> {
  const out = signal<T>(source.peek())
  let lastEmit = Number.NEGATIVE_INFINITY
  let trailingTimer: ReturnType<typeof setTimeout> | null = null
  let trailingValue: T = source.peek()
  let initial = true

  const dispose = effect(() => {
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

  const sig = options?.signal
  if (sig) {
    const stop = () => {
      if (trailingTimer != null) {
        clearTimeout(trailingTimer)
        trailingTimer = null
      }
      dispose()
    }
    if (sig.aborted) stop()
    else sig.addEventListener('abort', stop, { once: true })
  }

  return out
}
