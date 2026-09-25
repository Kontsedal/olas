import { scheduleExpiry } from '../expiry-timer'
import { effect, signal } from '../signals'
import { readOnly } from '../signals/readonly'
import type { ReadSignal } from '../signals/types'

/** Options for `debounced` and `throttled`. */
export type TimingOptions = {
  /**
   * Aborting it stops the timer and releases the source subscription.
   */
  signal?: AbortSignal
  /**
   * Emit on the leading edge of a window.
   */
  leading?: boolean
  /**
   * Emit on the trailing edge of a window.
   */
  trailing?: boolean
}

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
  /**
   * Tear down the internal effect (drop the subscription to `source`) and
   * clear any pending timer. Idempotent. Call this when the timing signal
   * has no `options.signal` tying its lifecycle to an AbortController —
   * otherwise the effect keeps `source` subscribed forever.
   */
  dispose(): void
}

/**
 * The window a timing signal waits, with `NaN` read as `0` and a dev warning.
 * The shared scheduler schedules nothing for a non-finite delay, the right
 * reading of `Infinity` but not of `NaN`: a failed `Number(...)` parse left the
 * signal never emitting, where a raw `setTimeout` fired at once. Internal;
 * shared with `throttled`.
 */
export function timingWindow(ms: number, name: 'debounced' | 'throttled'): number {
  if (!Number.isNaN(ms)) return ms
  if (__DEV__) {
    console.warn(
      `[olas] ${name}: the window is NaN — expected a number of milliseconds. It runs as 0.`,
    )
  }
  return 0
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
 *
 * `ms` goes through the shared expiry scheduler (spec §21.5): `Infinity`
 * never fires on its own, so only `flush()` emits, and a window past the
 * 32-bit timer limit waits its full length. `NaN` runs as `0`, with a warning
 * in development.
 */
export function debounced<T>(
  source: ReadSignal<T>,
  windowMs: number,
  options?: TimingOptions,
): TimingSignal<T> {
  const ms = timingWindow(windowMs, 'debounced')
  const leading = options?.leading ?? false
  const trailing = options?.trailing ?? true
  if (!leading && !trailing) {
    throw new Error(
      '[olas] debounced: at least one of `leading` or `trailing` must be true (both false never emits).',
    )
  }
  const out = signal<T>(source.peek())
  // The window goes through `scheduleExpiry`, as every user duration does
  // (§21.5): `Infinity` schedules nothing, and a window past the 32-bit
  // `setTimeout` limit cannot overflow into an immediate fire. `null` means no
  // timer is pending, which for `Infinity` is for good.
  let timer: (() => void) | null = null
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

  const disposeEffect = effect(() => {
    const value = source.value
    if (initial) {
      initial = false
      return
    }
    pendingValue = value
    timer?.()
    if (leading && !inCooldown) {
      // Leading edge — emit now, start a cooldown timer that, if untouched
      // by another write, fires the trailing edge with the same value.
      out.set(value)
      hasPending = false
      inCooldown = true
      timer = scheduleExpiry(ms, fireTrailing)
    } else {
      // Pending only matters if a trailing emit can actually happen. With
      // `trailing: false` the timer just resets the cooldown and must NOT
      // leave a value for a later `flush()` to emit. (T2.7)
      hasPending = trailing
      timer = scheduleExpiry(ms, fireTrailing)
    }
  })

  const cancel = () => {
    timer?.()
    timer = null
    hasPending = false
    inCooldown = false
  }
  const flush = () => {
    timer?.()
    timer = null
    if (hasPending) {
      out.set(pendingValue)
      hasPending = false
    }
    inCooldown = false
  }

  const dispose = () => {
    cancel()
    disposeEffect()
  }

  const sig = options?.signal
  if (sig) {
    if (sig.aborted) dispose()
    else sig.addEventListener('abort', dispose, { once: true })
  }

  // Expose a read-only projection of `out` plus the control surface. The old
  // `out as TimingSignal` cast leaked `out.set` to callers. (T2.7)
  const handle = Object.assign(Object.create(readOnly(out)), {
    cancel,
    flush,
    dispose,
  }) as TimingSignal<T>
  return handle
}
