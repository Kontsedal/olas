import { effect, signal } from '../signals'
import type { ReadSignal } from '../signals/types'

/**
 * Lag a signal by `ms`. The returned signal updates only after the source has
 * been unchanged for `ms`. Each new write resets the timer.
 *
 * No lifecycle — the internal effect runs for the lifetime of the program.
 * Use inside a controller closure so it dies with the closure.
 */
export function debounced<T>(source: ReadSignal<T>, ms: number): ReadSignal<T> {
  const out = signal<T>(source.peek())
  let timer: ReturnType<typeof setTimeout> | null = null
  let initial = true

  effect(() => {
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

  return out
}
