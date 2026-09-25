---
name: dispose-order-is-registration-order
description: Teardown is one reverse-registration pass over all entry kinds, not the phased children-then-effects-then-onDispose order SPEC used to state; whether an onDispose hook can still reach an effect depends on which was created first.
type: pitfall
covers:
  - packages/core/src/controller/instance.ts:300-349
  - packages/core/src/timing/debounced.ts:140-159
edges:
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: uses, target: ../modules/timing.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-25
confidence: high
---

# Dispose order is registration order, not phase order

## The trap

`SPEC.md` §4 described dispose as *"Cleanup runs bottom-up: children → caches/effects → `onDispose` hooks"* from bootstrap until 2026-09-03. That reads like three phases with hooks last. There are no phases.

`ControllerInstance.dispose()` walks **one** list — every `ctx.*` primitive, every child, every hook, in creation order — backwards, dispatching on `entry.kind` (`instance.ts:300-349`). Nothing groups by kind. So the relative order of an effect and an `onDispose` hook is decided entirely by which was created first:

```ts
ctx.effect(...)                     // registered first
ctx.onDispose(() => ...)            // → runs BEFORE the effect is torn down

ctx.onDispose(() => ...)            // registered first
ctx.effect(...)                     // → runs AFTER the effect is torn down
```

The guarantee is LIFO — a thing is torn down before whatever it was built on top of — and that is the only one.

## Why it matters

It decides whether a hook can still use a collaborator. The live case is flushing a pending `debounced` write at unmount (§9). `TimingSignal.dispose()` calls `cancel()` and tears down the internal effect at `debounced.ts:156-159`, so it **drops** the pending value. Keeping the write means `flush()` first — and `flush()` only lands if the effect that consumes the debounced signal is still subscribed:

```ts
const settled = debounced(width.signal, 500)
ctx.effect(() => void save({ width: settled.value }))   // registered first…

ctx.onDispose(() => {
  settled.flush()    // …so the effect is still live here and the write lands
  settled.dispose()
})
```

Swap the two registrations and `flush()` emits into nothing — silently. There is no error and no warning; a resize made inside the debounce window is never persisted, and only on unmount.

## The rule

When an `onDispose` hook needs to *do* something through a controller primitive rather than only release a resource, **create the primitive first**. That is hard to guarantee when a composable adds the hook and the caller adds the effect. Do not rely on ordering there. Register the flush with something that owns the timing explicitly, such as an app-level pending-writes drain, or flush at the event that should persist rather than at teardown.

## Where it's documented

`SPEC.md` §4 now states reverse-registration order and carries the flush example. The wiki had it right all along. `modules/controller.md`, `overview.md` and `entities/controller-instance.md` all say "iterates reverse". That is the other lesson: the spec and the wiki disagreed for months, and nothing checks one against the other.
