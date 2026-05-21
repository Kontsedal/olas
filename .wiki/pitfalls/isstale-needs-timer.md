---
name: isstale-needs-timer
description: isStale cannot be a computed of Date.now() — its dependencies don't change as time passes. Use a Signal with a setTimeout.
type: pitfall
covers:
  - packages/core/src/query/entry.ts:48-110
edges:
  - { type: tested-by, target: ../../packages/core/tests/cache.test.ts }
  - { type: uses, target: ../entities/entry.md }
last_verified: 2026-05-21
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
  if (this.staleTimer != null) clearTimeout(this.staleTimer)
  if (this.staleTime > 0) {
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null
      if (!this.disposed) this.isStale.set(true)
    }, this.staleTime)
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

When code needs the imperative answer ("is this stale RIGHT NOW for purposes of deciding whether to refetch on subscribe?"), use `entry.isStaleNow()` — it computes `Date.now() - lastUpdatedAt >= staleTime` on the spot. This is what `bindEntry` and `prefetch` use; the reactive `isStale` signal is for UI / consumer subscriptions.

```ts
isStaleNow(): boolean {
  const last = this.lastUpdatedAt.peek()
  if (last === undefined) return true
  return Date.now() - last >= this.staleTime
}
```

## When to be careful

Anywhere "is something stale / expired" is exposed as a reactive signal, you need a timer. `Date.now()`-derived computeds are inert.
