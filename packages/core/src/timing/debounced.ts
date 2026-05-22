import { effect, signal } from '../signals'
import type { ReadSignal } from '../signals/types'

/**
 * A `ReadSignal<T>` returned by `debounced` / `throttled`. Extends the
 * subscription surface with manual `cancel()` and `flush()`.
 *
 * - `cancel()` drops any pending emission without firing. Useful when a
 *   navigation away from the screen should discard the latest in-flight
 *   draft instead of writing it through to the debounced output.
 * - `flush()` immediately emits the pending value (if any). Useful at
 *   submit time: "commit whatever the user just typed without waiting
 *   for the debounce timer to fire."
 *
 * Both are no-ops when nothing is pending.
 */
export type TimingSignal<T> = ReadSignal<T> & {
  cancel(): void
  flush(): void
}

/**
 * Lag a signal by `ms`. The returned signal updates only after the source has
 * been unchanged for `ms`. Each new write resets the timer.
 *
 * - `leading: true` (default `false`) emits immediately on the first write,
 *   then suppresses further writes until `ms` has passed since the last
 *   emission. Combine with trailing (default `true`) for "first + last"
 *   semantics.
 * - `trailing: false` disables the trailing emission. Pair with
 *   `leading: true` for "only fire on the leading edge" semantics.
 * - `options.signal` (`AbortSignal`) ties the internal effect to a
 *   lifecycle — when the signal aborts the effect disposes, the pending
 *   timer clears, and the subscriber chain on `source` drops.
 */
export function debounced<T>(
  source: ReadSignal<T>,
  ms: number,
  options?: { signal?: AbortSignal; leading?: boolean; trailing?: boolean },
): TimingSignal<T> {
  const leading = options?.leading ?? false
  const trailing = options?.trailing ?? true
  const out = signal<T>(source.peek())
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingValue: T = source.peek()
  let hasPending = false
  let initial = true
  let inCooldown = false

  const fireTrailing = () => {
    timer = null
    inCooldown = false
    if (hasPending && trailing) {
      out.set(pendingValue)
      hasPending = false
    }
  }

  const dispose = effect(() => {
    const value = source.value
    if (initial) {
      initial = false
      return
    }
    pendingValue = value
    hasPending = true
    if (timer != null) clearTimeout(timer)
    if (leading && !inCooldown) {
      // Leading edge — emit now, start a cooldown timer that, if untouched
      // by another write, fires the trailing edge with the same value.
      out.set(value)
      hasPending = false
      inCooldown = true
      timer = setTimeout(fireTrailing, ms)
    } else {
      timer = setTimeout(fireTrailing, ms)
    }
  })

  const cancel = () => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    hasPending = false
    inCooldown = false
  }
  const flush = () => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    if (hasPending) {
      out.set(pendingValue)
      hasPending = false
    }
    inCooldown = false
  }

  const sig = options?.signal
  if (sig) {
    const stop = () => {
      cancel()
      dispose()
    }
    if (sig.aborted) stop()
    else sig.addEventListener('abort', stop, { once: true })
  }

  // Attach control methods to the read-signal handle so call sites get one
  // value. The cast is safe — `signal()` returns a Signal which already
  // implements ReadSignal; we're just widening to add control surface.
  const handle = out as unknown as TimingSignal<T>
  Object.defineProperty(handle, 'cancel', { value: cancel, enumerable: false })
  Object.defineProperty(handle, 'flush', { value: flush, enumerable: false })
  return handle
}
