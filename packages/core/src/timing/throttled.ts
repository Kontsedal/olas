import { effect, signal } from '../signals'
import type { ReadSignal } from '../signals/types'
import type { TimingSignal } from './debounced'

/**
 * Time source — `Date.now()`. Stays in lockstep with `vi.setSystemTime()`
 * for tests that exercise time-jumps; downstream consumers that need a
 * monotonic clock can pass `options.signal` and gate on system-time
 * changes externally.
 */
function now(): number {
  return Date.now()
}

/**
 * Rate-limit a signal so it emits at most once per `ms` (leading + trailing).
 * The first change passes through immediately. Subsequent changes within the
 * window are coalesced; the latest value is emitted when the window expires.
 *
 * - `leading: false` (default `true`) skips the immediate leading-edge
 *   emission. Useful for "fire only after the window settles" semantics.
 * - `trailing: false` (default `true`) skips the windowed trailing emit.
 *   Combine with `leading: true` for "only fire on the leading edge."
 * - `options.signal` ties the internal effect to a lifecycle.
 *
 * The returned handle exposes `cancel()` / `flush()` — see `TimingSignal`.
 */
export function throttled<T>(
  source: ReadSignal<T>,
  ms: number,
  options?: { signal?: AbortSignal; leading?: boolean; trailing?: boolean },
): TimingSignal<T> {
  const leading = options?.leading ?? true
  const trailing = options?.trailing ?? true
  const out = signal<T>(source.peek())
  let lastEmit = Number.NEGATIVE_INFINITY
  let trailingTimer: ReturnType<typeof setTimeout> | null = null
  let trailingValue: T = source.peek()
  let hasPending = false
  let initial = true

  const fireTrailing = () => {
    trailingTimer = null
    if (hasPending && trailing) {
      out.set(trailingValue)
      lastEmit = now()
      hasPending = false
    }
  }

  const dispose = effect(() => {
    const value = source.value
    if (initial) {
      initial = false
      return
    }
    const t = now()
    const elapsed = t - lastEmit
    if (elapsed >= ms) {
      if (leading) {
        out.set(value)
        lastEmit = t
        hasPending = false
      } else {
        trailingValue = value
        hasPending = true
        if (trailingTimer == null) trailingTimer = setTimeout(fireTrailing, ms)
      }
      // Drop any stale trailing-pending; the leading emit consumed the value.
      if (leading && trailingTimer != null) {
        clearTimeout(trailingTimer)
        trailingTimer = null
      }
    } else {
      trailingValue = value
      hasPending = true
      if (trailingTimer == null) trailingTimer = setTimeout(fireTrailing, ms - elapsed)
    }
  })

  const cancel = () => {
    if (trailingTimer != null) {
      clearTimeout(trailingTimer)
      trailingTimer = null
    }
    hasPending = false
  }
  const flush = () => {
    if (trailingTimer != null) {
      clearTimeout(trailingTimer)
      trailingTimer = null
    }
    if (hasPending) {
      out.set(trailingValue)
      lastEmit = now()
      hasPending = false
    }
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

  const handle = out as unknown as TimingSignal<T>
  Object.defineProperty(handle, 'cancel', { value: cancel, enumerable: false })
  Object.defineProperty(handle, 'flush', { value: flush, enumerable: false })
  return handle
}
