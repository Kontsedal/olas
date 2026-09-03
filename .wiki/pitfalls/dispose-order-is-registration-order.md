---
name: dispose-order-is-registration-order
description: Teardown is one reverse-registration pass over all entry kinds, not the phased children-then-effects-then-onDispose order SPEC used to state; whether an onDispose hook can still reach an effect depends on which was created first.
type: pitfall
covers:
  - packages/core/src/controller/instance.ts:265-313
  - packages/core/src/timing/debounced.ts:104-119
edges:
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: uses, target: ../modules/timing.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-03
confidence: high
---

# Dispose order is registration order, not phase order

## The trap

`SPEC.md` §4 described dispose as *"Cleanup runs bottom-up: children → caches/effects → `onDispose` hooks"* from bootstrap until 2026-09-03. That reads like three phases with hooks last. There are no phases.

`ControllerInstance.dispose()` walks **one** list — every `ctx.*` primitive, every child, every hook, in creation order — backwards, dispatching on `entry.kind` (`instance.ts:265-286`). Nothing groups by kind. So the relative order of an effect and an `onDispose` hook is decided entirely by which was created first:

```ts
ctx.effect(...)                     // registered first
ctx.onDispose(() => ...)            // → runs BEFORE the effect is torn down

ctx.onDispose(() => ...)            // registered first
ctx.effect(...)                     // → runs AFTER the effect is torn down
```

The guarantee is LIFO — a thing is torn down before whatever it was built on top of — and that is the only one.

## Why it matters

It decides whether a hook can still use a collaborator. The live case is flushing a pending `debounced` write at unmount (§9): `TimingSignal.dispose()` is `cancel()` + tear down the internal effect (`debounced.ts:116-119`), so it **drops** the pending value. Keeping the write means `flush()` first — and `flush()` only lands if the effect that consumes the debounced signal is still subscribed:

```ts
const settled = debounced(width.signal, 500)
ctx.effect(() => void save({ width: settled.value }))   // registered first…

ctx.onDispose(() => {
  settled.flush()    // …so the effect is still live here and the write lands
  settled.dispose()
})
```

Swap the two registrations and `flush()` emits into nothing — silently. There is no error and no warning; a resize made inside the debounce window is simply never persisted, and only on unmount.

## The rule

When an `onDispose` hook needs to *do* something through a controller primitive rather than just release a resource, **create the primitive first**. If that is hard to guarantee — the hook added by a composable, the effect by the caller — don't rely on ordering: register the flush with something that owns the timing explicitly (an app-level pending-writes drain), or flush at the event that should persist rather than at teardown.

## Where it's documented

`SPEC.md` §4 now states reverse-registration order and carries the flush example. The wiki had it right all along — `modules/controller.md`, `overview.md` and `entities/controller-instance.md` all say "iterates reverse" — which is the other lesson: the spec and the wiki disagreed for months and nothing checks one against the other.
