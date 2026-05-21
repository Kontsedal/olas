---
name: preact-signals-overload-return
description: ReturnType<typeof signal<T>> gives Signal<T | undefined> due to TS overload resolution. Use PreactSignal<T> directly.
type: pitfall
covers:
  - packages/core/src/signals/runtime.ts:13-43
edges:
  - { type: uses, target: ../modules/signals.md }
last_verified: 2026-05-21
confidence: high
---

# `ReturnType<typeof signal<T>>` is `Signal<T | undefined>`, not `Signal<T>`

## The trap

`@preact/signals-core` declares `signal` with two overloads:

```ts
function signal<T>(value: T): Signal<T>
function signal<T = undefined>(): Signal<T | undefined>
```

If you write:

```ts
class SignalImpl<T> {
  private readonly inner: ReturnType<typeof _signal<T>>
}
```

TypeScript resolves `ReturnType<typeof signal<T>>` using the **last** overload by default — `Signal<T | undefined>`. Even though we always call `_signal(initial)` (matching the first overload), the type machinery doesn't know that.

Downstream consequences: `.peek(): T | undefined`, setter accepts `T | undefined`, etc. Code that should be `T` becomes `T | undefined` everywhere it touches `inner`.

## The bug we hit

Phase 1 typecheck failed with:

```
src/signals/runtime.ts(39,27): error TS2345:
Argument of type 'T | undefined' is not assignable to parameter of type 'T'.
'T' could be instantiated with an arbitrary type which could be unrelated to 'T | undefined'.
```

The offending line was inside `update`:

```ts
update(fn: (prev: T) => T): void {
  this.inner.value = fn(this.inner.peek())  // peek() is T | undefined → fn rejects
}
```

## The fix

Import the class directly and declare the field with the typed-class form:

```ts
import { type Signal as PreactSignal, signal as _signal } from '@preact/signals-core'

class SignalImpl<T> {
  private readonly inner: PreactSignal<T>     // strict T, no union

  constructor(initial: T) {
    this.inner = _signal<T>(initial)
  }
}
```

Same trick for `ComputedImpl` using `PreactReadonlySignal<T>`.

## Why this matters for review

If anyone refactors `runtime.ts` to use `ReturnType<typeof _signal<T>>` thinking it's equivalent, the typecheck will fail with a confusing "T | undefined" error. The class-typed form is the load-bearing escape hatch — keep it.

## Related: `ReturnType<typeof f<T>>` in general

This isn't specific to `@preact/signals-core`. Any time you compute `ReturnType<typeof f<T>>` for an overloaded `f`, TypeScript picks one overload (usually the last). When in doubt: declare the field with the explicit class/interface form, not via inference from the function.
