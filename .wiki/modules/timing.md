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
last_verified: 2026-05-22
confidence: high
---

# `timing/`

`debounced(source, ms)` and `throttled(source, ms)` — return `ReadSignal<T>` that mirrors `source` with the corresponding timing. Spec §9, §20.1.

## Lifecycle

**These functions do NOT take `ctx`.** They allocate an internal `effect` that subscribes to `source` for the lifetime of the program. The "lifecycle" inherits from the source.

In practice: invoke them inside a controller closure so the closure (and the captured derived signal) is reachable only while the controller is alive. After dispose, no one holds a reference, garbage collection eventually reclaims the effect.

## Throttled semantics

Leading + trailing: the first change in a quiet window emits immediately. Subsequent changes within `ms` are coalesced; the latest value emits when the window expires. `lastEmit = Number.NEGATIVE_INFINITY` initially so the very first change passes through.

## Both: the "skip first effect" trick

Both implementations have `let initial = true` to skip the effect's first run. That first run reads `source.value` purely to establish the tracking dependency — we don't want to emit because the output signal is already initialized to `source.peek()`.
