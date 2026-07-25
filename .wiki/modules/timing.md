---
name: timing
description: debounced(signal) and throttled(signal) — pure signal projections, no lifecycle.
type: module
covers:
  - packages/core/src/timing/debounced.ts
  - packages/core/src/timing/throttled.ts
  - packages/core/src/timing/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/timing.test.ts }
  - { type: uses, target: signals.md }
last_verified: 2026-07-25
confidence: high
---

# `timing/`

`debounced(source, ms, options?)` and `throttled(source, ms, options?)` — return a `TimingSignal<T>` (a `ReadSignal<T>` plus `cancel()` / `flush()` / `dispose()`) that mirrors `source` with the corresponding timing. Spec §9, §20.1.

## Lifecycle

**These functions do NOT take `ctx`.** They allocate an internal `effect` that subscribes to `source`. That subscription lives until torn down one of two ways (T2.7):

- Pass `options.signal` (an `AbortSignal`) — on abort the effect disposes, the pending timer clears, and the `source` subscription drops. Tie it to `ctx.onDispose` via an `AbortController` for controller-scoped lifetime.
- Call `handle.dispose()` — idempotent; same teardown, manual.

Without either, the effect keeps `source` subscribed for the process lifetime (GC can't reclaim it while `source` is alive). The returned handle is a **read-only** projection of the internal signal (via `readOnly()`) plus the control methods — `set()` is NOT exposed (the old `out as TimingSignal` cast leaked it).

## Options matrix (`leading` / `trailing`)

- Defaults: `debounced` = `{ leading: false, trailing: true }`; `throttled` = `{ leading: true, trailing: true }`.
- `leading: true` emits on the first change of a quiet window; `trailing: true` emits the coalesced latest value when the window settles. `{ leading: true, trailing: false }` = "leading edge only"; the reverse = "trailing edge only".
- `{ leading: false, trailing: false }` never emits and **throws** at construction.
- With `trailing: false`, no trailing timer is scheduled and nothing is left pending, so `flush()` emits nothing (it previously leaked a value the option said should never fire). Pinned by the `timing.test.ts` options matrix (T2.7).

## Throttled semantics

Leading + trailing: the first change in a quiet window emits immediately. Subsequent changes within `ms` are coalesced; the latest value emits when the window expires. `lastEmit = Number.NEGATIVE_INFINITY` initially so the very first change passes through.

## Both: the "skip first effect" trick

Both implementations have `let initial = true` to skip the effect's first run. That first run reads `source.value` purely to establish the tracking dependency — we don't want to emit because the output signal is already initialized to `source.peek()`.
