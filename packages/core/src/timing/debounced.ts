import { effect, signal } from '../signals'
import { readOnly } from '../signals/readonly'
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
  /**
   * Tear down the internal effect (drop the subscription to `source`) and
   * clear any pending timer. Idempotent. Call this when the timing signal
   * has no `options.signal` tying its lifecycle to an AbortController —
   * otherwise the effect keeps `source` subscribed forever.
   */
  dispose(): void
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
  if (!leading && !trailing) {
    throw new Error(
      '[olas] debounced: at least one of `leading` or `trailing` must be true (both false never emits).',
    )
  }
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

  const disposeEffect = effect(() => {
    const value = source.value
    if (initial) {
      initial = false
      return
    }
    pendingValue = value
    if (timer != null) clearTimeout(timer)
    if (leading && !inCooldown) {
      // Leading edge — emit now, start a cooldown timer that, if untouched
      // by another write, fires the trailing edge with the same value.
      out.set(value)
      hasPending = false
      inCooldown = true
      timer = setTimeout(fireTrailing, ms)
    } else {
      // Pending only matters if a trailing emit can actually happen. With
      // `trailing: false` the timer just resets the cooldown and must NOT
      // leave a value for a later `flush()` to emit. (T2.7)
      hasPending = trailing
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
