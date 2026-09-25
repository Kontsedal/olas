/**
 * Schedule a one-shot expiry without lying about the delay.
 *
 * Two platform behaviours make a bare `setTimeout(fn, delay)` wrong for any
 * user-supplied duration: a non-finite delay is coerced to 1ms rather than
 * "never", and a finite delay above the signed 32-bit limit overflows and
 * also fires almost immediately. Both turn "keep this for a very long time"
 * into "drop this on the next tick" — the opposite of the intent.
 *
 * So: `Infinity` (or any non-finite value) schedules nothing and returns
 * `null` — the caller's `timer == null` state already means "no expiry
 * pending". Finite delays are walked in chunks against an absolute deadline,
 * which also keeps a long timer honest across chunk boundaries.
 *
 * Returns a cancellation closure, or `null` when nothing was scheduled.
 * Used for both staleness (`Entry` / `InfiniteEntry`) and gc (`ClientEntry` /
 * `InfiniteClientEntry`). Spec §21.5.
 */
const MAX_DELAY = 2_147_483_647

export function scheduleExpiry(delay: number, onExpire: () => void): (() => void) | null {
  if (!Number.isFinite(delay)) return null
  const deadline = Date.now() + delay
  let timer: ReturnType<typeof setTimeout>
  const tick = () => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) onExpire()
    else timer = setTimeout(tick, Math.min(remaining, MAX_DELAY))
  }
  timer = setTimeout(tick, Math.min(Math.max(0, delay), MAX_DELAY))
  return () => clearTimeout(timer)
}
