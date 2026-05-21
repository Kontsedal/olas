import { effect, signal } from '../signals'
import type { ReadSignal } from '../signals/types'

/**
 * Lag a signal by `ms`. The returned signal updates only after the source has
 * been unchanged for `ms`. Each new write resets the timer.
 *
 * Pass `options.signal` (an `AbortSignal`) to tie the internal effect to a
 * lifecycle — when the signal aborts the effect disposes, the pending timer
 * clears, and the subscriber chain on `source` drops. Without `signal`, the
 * effect lives as long as `source` does; pass a signal whenever the source
 * outlives the consumer.
 */
export function debounced<T>(
  source: ReadSignal<T>,
  ms: number,
  options?: { signal?: AbortSignal },
): ReadSignal<T> {
  const out = signal<T>(source.peek())
  let timer: ReturnType<typeof setTimeout> | null = null
  let initial = true

  const dispose = effect(() => {
    const value = source.value
    if (initial) {
      // The first effect run reads the source for tracking; we already
      // initialized `out` to the same value, so skip scheduling.
      initial = false
      return
    }
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      out.set(value)
      timer = null
    }, ms)
  })

  const sig = options?.signal
  if (sig) {
    const stop = () => {
      if (timer != null) {
        clearTimeout(timer)
        timer = null
      }
      dispose()
    }
    if (sig.aborted) stop()
    else sig.addEventListener('abort', stop, { once: true })
  }

  return out
}
