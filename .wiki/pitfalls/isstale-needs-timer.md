---
name: isstale-needs-timer
description: Expiry cannot be a computed of Date.now() — its deps don't change as time passes. Use a Signal with a timer, and don't hand that timer a raw delay.
type: pitfall
covers:
  - packages/core/src/query/entry.ts:48-110
  - packages/core/src/expiry-timer.ts
  - packages/core/src/utils.ts
  - packages/core/src/controller/root.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/expiry-timers.test.ts }
  - { type: uses, target: ../entities/entry.md }
last_verified: 2026-09-20
confidence: high
---

# `isStale` needs a timer, not a computed

## The trap

The intuitive implementation:

```ts
// BAD — never re-evaluates as time passes
readonly isStale = computed(() => {
  const last = this.lastUpdatedAt.value
  if (last === undefined) return true
  return Date.now() - last >= this.staleTime
})
```

A `computed` only recomputes when one of its tracked dependencies changes. The tracked deps here are `this.lastUpdatedAt`. Once that's set, the computed memoizes — `Date.now()` increasing doesn't trigger anything.

So `isStale` would stay `false` forever until the next fetch, regardless of how much time elapsed.

## The bug we hit

Phase 4's staleness test:

```ts
test('isStale ... false right after, true after staleTime', async () => {
  vi.setSystemTime(0)
  const def = defineController((ctx) => ({
    x: ctx.cache(async () => 'v', { staleTime: 100 }),
  }))
  const root = createRoot(def, { deps: emptyDeps })
  await vi.advanceTimersByTimeAsync(0)
  expect(root.x.isStale.value).toBe(false)          # pass

  vi.advanceTimersByTime(110)                       # 110ms later
  expect(root.x.isStale.value).toBe(true)           # FAIL — was still false
})
```

The `computed` approach memoized `false` and never re-checked.

## The fix

Make `isStale` a `Signal<boolean>` set by a timer:

```ts
readonly isStale: Signal<boolean> = signal(true)

private scheduleStaleness(): void {
  if (this.staleTimer != null) this.staleTimer()       # cancellation closure, not a handle
  if (this.staleTime > 0) {
    this.staleTimer = scheduleExpiry(this.staleTime, () => {
      this.staleTimer = null
      if (!this.disposed) this.isStale.set(true)
    })
  }
}

private applySuccess(result: T): T {
  batch(() => {
    this.data.set(result); ...
    this.isStale.set(this.staleTime === 0)   # immediately stale if staleTime is 0
  })
  if (this.staleTime > 0) this.scheduleStaleness()
  return result
}
```

Plus:
- `invalidate()` clears the timer and flips `isStale = true` immediately.
- `dispose()` clears the timer.
- `staleTime: 0` → `isStale` stays true (every fresh fetch immediately becomes stale).

Subscribers to `isStale` now see the flip happen at the right moment.

## A separate helper for "check stale right now"

When code needs the imperative answer ("is this stale RIGHT NOW for purposes of deciding whether to refetch on subscribe?"), use `entry.isStaleNow()` — it computes `Date.now() - lastUpdatedAt >= staleTime` on the spot. This is what `bindEntry` and `prefetch` use; the reactive `isStale` signal is for UI or consumer subscriptions.

```ts
isStaleNow(): boolean {
  const last = this.lastUpdatedAt.peek()
  if (last === undefined) return true
  return Date.now() - last >= this.staleTime
}
```

## The second half of the trap: don't hand the timer a raw delay (0.9)

Having established that you need a timer, the obvious next line is `setTimeout(fn, this.staleTime)`. That is wrong for any duration the *user* supplies, and it fails in the direction a test rarely covers. `setTimeout` takes a signed 32-bit delay. A non-finite value is coerced toward 1ms rather than "never". A finite value above 2,147,483,647 overflows and also fires almost immediately. So the two settings that mean "keep this the longest" behave as the shortest:

```ts
staleTime: Infinity   # intent: never goes stale.   Actual (pre-0.9): stale in ~1ms
gcTime: Infinity      # intent: cache for the session. Actual (pre-0.9): collected in ~1ms
```

This is a *silent* failure — data still renders, it refetches constantly — which is why both survived until an audit. `scheduleExpiry` (`expiry-timer.ts`) is the fix and the only place a duration should meet a timer:

- non-finite → schedules **nothing**, returns `null`. The callers already treat `timer == null` as "no expiry pending", so `Infinity` falls out as "never" with no special case at the call site.
- finite → walked in chunks against an absolute deadline, so a long delay stays accurate across chunk boundaries.
- returns a **cancellation closure** rather than a handle, so callers can't accidentally `clearTimeout` a chunked timer's stale inner id.

Every user-supplied duration in core routes through it: the staleness timer in `Entry` and `InfiniteEntry`, the gc timer in `ClientEntry` and `InfiniteClientEntry`, the `refetchInterval` chain in `ClientEntry.armIntervalTick` and its infinite twin, the retry backoff in `abortableSleep` fed by user `retryDelay`, and `suspend({ maxIdle })` in `controller/root.ts`.

`refetchInterval` is worth calling out, because it looks guarded and is not quite. `resolveRefetchInterval` at `client.ts:60-91` rejects non-finite and non-positive gaps and stops the chain loudly, which covers `Infinity`. A *finite* gap above the 32-bit limit sails through that guard and overflows anyway, turning the longest interval you can ask for into a ~1ms poll storm. Rejecting `Infinity` is not the same as handling overflow; both halves need the scheduler.

## When to be careful

Anywhere "is something stale and expired" is exposed as a reactive signal, you need a timer. `Date.now()`-derived computeds are inert. And any timer whose delay comes from user config needs `scheduleExpiry`, not `setTimeout` — the failure mode is the opposite of what the setting says, and it is invisible.
