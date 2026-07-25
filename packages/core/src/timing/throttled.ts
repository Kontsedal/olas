import { effect, signal } from '../signals'
import { readOnly } from '../signals/readonly'
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
  if (!leading && !trailing) {
    throw new Error(
      '[olas] throttled: at least one of `leading` or `trailing` must be true (both false never emits).',
    )
  }
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

  const disposeEffect = effect(() => {
    const value = source.value
    if (initial) {
      initial = false
      return
    }
    const t = now()
    const elapsed = t - lastEmit
    if (elapsed >= ms && leading) {
      out.set(value)
      lastEmit = t
      hasPending = false
      // The leading emit consumed the value — drop any stale trailing-pending.
      if (trailingTimer != null) {
        clearTimeout(trailingTimer)
        trailingTimer = null
      }
    } else if (trailing) {
      // Coalesce into the trailing edge. With `trailing: false` we schedule
      // nothing and never set `hasPending`, so a later `flush()` can't emit a
      // value the option said should never fire. (T2.7)
      trailingValue = value
      hasPending = true
      const delay = elapsed >= ms ? ms : ms - elapsed
      if (trailingTimer == null) trailingTimer = setTimeout(fireTrailing, delay)
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

  const dispose = () => {
    cancel()
    disposeEffect()
  }

  const sig = options?.signal
  if (sig) {
    if (sig.aborted) dispose()
    else sig.addEventListener('abort', dispose, { once: true })
  }

  // Read-only projection + control surface; the old cast leaked `out.set`. (T2.7)
  const handle = Object.assign(Object.create(readOnly(out)), {
    cancel,
    flush,
    dispose,
  }) as TimingSignal<T>
  return handle
}
