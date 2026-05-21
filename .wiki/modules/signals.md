---
name: signals
description: Reactive primitives — the only consumer of @preact/signals-core.
type: module
covers:
  - packages/core/src/signals/types.ts
  - packages/core/src/signals/runtime.ts
  - packages/core/src/signals/readonly.ts
  - packages/core/src/signals/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/signals.test.ts }
  - { type: uses, target: ../decisions/signals-runtime-wrapped.md }
  - { type: related, target: ../pitfalls/preact-signals-overload-return.md }
last_verified: 2026-05-22
confidence: high
---

# `packages/core/src/signals/`

## Purpose

Reactive primitives — `signal`, `computed`, `effect`, `batch`, `untracked`, plus the types `Signal<T>`, `ReadSignal<T>`, `Computed<T>`. Wraps `@preact/signals-core` behind our own surface so the underlying runtime can change without touching the rest of the codebase. Spec §20.1.

## Public surface

```ts
function signal<T>(initial: T): Signal<T>
function computed<T>(fn: () => T): Computed<T>
function effect(fn: () => void | (() => void)): () => void  // returns dispose
function batch<T>(fn: () => T): T
function untracked<T>(fn: () => T): T

type ReadSignal<T> = { readonly value: T; peek(): T; subscribe(handler: (v: T) => void): () => void }
type Signal<T>     = ReadSignal<T> & { value: T; set(v: T): void; update(fn: (prev: T) => T): void }
type Computed<T>   = ReadSignal<T>
```

`Signal<T>` extends `ReadSignal<T>` structurally — assignable downward only. The runtime is `SignalImpl` and `ComputedImpl` classes in `runtime.ts:13-66`.

## Internal helper

`readOnly(source)` in `signals/readonly.ts` returns a fresh `ReadSignal<T>` view that omits `set` / `update` / writable `.value`. The returned object is `Object.freeze`d, so a `(ro as any).value = …` assignment throws in strict mode and is a no-op in sloppy mode — defense-in-depth on top of the type system, not a substitute for it. Use when exposing a `Signal` as a `ReadSignal` on a public surface.

## Subscribe semantics

`subscribe(handler)` from `@preact/signals-core` fires immediately with the current value AND on every change. This is the upstream behavior we keep; some consumers rely on the initial sync delivery (e.g. `@kontsedal/olas-persist` uses it to read the source after load — and explicitly skips the first delivery to avoid writing back). See `pitfalls/preact-signals-overload-return.md`.

## Why wrapped, not re-exported

- A stable public surface independent of the upstream library.
- Add `.set()` / `.update()` methods we want even though upstream uses property setters.
- Make `readOnly(...)` projection mechanically sound.
- Dodge a TS overload-resolution bug in upstream — see `pitfalls/preact-signals-overload-return.md`.

## Gotchas

- `effect`'s callback can return a cleanup — that cleanup runs **before the next re-run AND on dispose**. Symmetric with React effects.
- `untracked(fn)` reads inside `fn` are excluded from the surrounding tracking scope. For a single read, `signal.peek()` is more idiomatic.
- `computed` is lazy + memoized. It recomputes only when read after a tracked dep changed.
