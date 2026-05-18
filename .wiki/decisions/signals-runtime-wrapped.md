---
name: signals-runtime-wrapped
description: Why @preact/signals-core is hidden behind a thin wrapper, not re-exported.
type: decision
covers:
  - packages/core/src/signals/runtime.ts
  - packages/core/src/signals/types.ts
edges:
  - { type: uses, target: ../modules/signals.md }
  - { type: related, target: ../pitfalls/preact-signals-overload-return.md }
last_verified: 2026-05-18
confidence: high
---

# Why signals are wrapped, not re-exported

## The choice

`packages/core/src/signals/runtime.ts` exposes `SignalImpl` and `ComputedImpl` classes that wrap `@preact/signals-core`. The rest of `@olas/core` never imports from `@preact/signals-core` directly — only through this module.

## Why not re-export?

Three reasons:

### 1. A stable public surface

`Signal<T>` and `ReadSignal<T>` are part of the library's API. If we re-exported upstream types directly, any change in `@preact/signals-core` (renaming, signature tweak) would be a breaking change for consumers. Wrapping lets us pin our types and adapt internally.

### 2. Custom `.set()` / `.update()`

The Olas spec uses `.set(value)` / `.update(fn)` methods on `Signal<T>`. `@preact/signals-core` uses property setters (`signal.value = x`). Both work; ours composes better with method-style usage and tools like Immer (`update(prev => produce(prev, ...))`).

The wrapper class exposes both:

```ts
get value(): T { return this.inner.value }
set value(next: T) { this.inner.value = next }
set(value: T): void { this.inner.value = value }
update(fn: (prev: T) => T): void { this.inner.value = fn(this.inner.peek()) }
```

### 3. `readOnly(...)` projection

`readOnly(signal)` returns an object that hides `set` / `update` / writable `.value` at runtime, not just at the type level. Re-exporting raw signals would mean users could cast through type checks to get a writer. The wrapper plus `readOnly` gives a defense-in-depth boundary.

## What we'd lose by NOT wrapping

We dodge `pitfalls/preact-signals-overload-return.md` — upstream's `signal` overloads cause `ReturnType<typeof signal<T>>` to resolve to `Signal<T | undefined>`. We use `PreactSignal<T>` directly in the field declaration to skip the bug. Without wrapping, every internal use would hit this.

## The cost

Two extra class allocations per signal. Negligible. The signals module is ~120 lines.
