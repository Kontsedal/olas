---
name: suspended-effects-lose-deps
description: An effect that early-returns before reading its tracked signals empties its dependency set and goes inert.
type: pitfall
covers:
  - packages/core/src/query/use.ts:145-177
  - packages/core/src/query/use.ts:367-399
edges:
  - { type: related, target: ../flows/query-subscription.md }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
last_verified: 2026-07-25
confidence: high
---

# Pitfall: a suspended effect that early-returns loses its dependencies

`@preact/signals-core`'s `effect(fn)` records as dependencies **exactly the signals `fn` reads during its most recent run**. If a run reads no signals, the effect has no dependencies and will never re-run.

This is a trap for any effect that early-returns on a plain (non-signal) boolean before reading the signals it normally tracks:

```ts
// BROKEN — the binding effect in ctx.use
effect(() => {
  if (suspended) return          // `suspended` is a closure boolean, not a signal
  const args = keyFn()           // TRACKED — but only reached when NOT suspended
  bind(args)
})
```

The failure sequence (T2.1):

1. Initial run (not suspended): reads `keyFn()` → deps = the key signals. Binds.
2. `suspend()` sets `suspended = true` (does NOT re-fire the effect — `suspended` isn't a signal).
3. A key signal changes **while suspended** → the effect re-runs → hits `if (suspended) return` → reads **no** signals → **deps become empty**.
4. `resume()` imperatively rebinds once (masking the bug for the key as of resume time), but the effect's deps are gone.
5. Every later key change is ignored — the subscription is inert forever.

## The fix

Read the tracked signals **first**, then early-return:

```ts
effect(() => {
  const isEnabled = enabledFn ? enabledFn() : true
  const args = isEnabled ? keyFn() : undefined   // key read only when enabled
  if (suspended) return                          // deps already captured above
  // …bind using args…
})
```

Now a change during suspension re-runs the effect, it re-reads the same signals, and its dependency set survives. The key is still read only when enabled, so an `enabled`-guarded key thunk (one that derefs state that only exists once enabled) never throws.

Pinned by `regressions.test.ts` (R-L2.1), regular + infinite variants.

## General rule

**If an effect can early-return, do the tracked reads before the return.** An effect's dependency set is only as complete as its last run; a run that reads nothing unsubscribes from everything.
