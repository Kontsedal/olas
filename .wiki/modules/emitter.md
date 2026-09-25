---
name: emitter
description: Standalone Emitter<T> — emit / on / once / dispose. Used by ctx.emitter.
type: module
covers:
  - packages/core/src/emitter.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/emitter.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/controller-regressions.test.ts }
  - { type: uses, target: controller.md }
last_verified: 2026-09-25
confidence: high
---

# `emitter.ts`

`createEmitter<T>()` returns `Emitter<T> = { emit, on, once, dispose }`. Spec §7, §20.6.

## Why both standalone and ctx-bound

- `createEmitter<T>()` — handlers persist until explicitly unsubscribed or the emitter is disposed. Use in `deps` for cross-tree busses (the "blessed escape hatch" — spec §10.2).
- `ctx.emitter<T>()` — wraps `createEmitter` and registers `dispose` as a controller cleanup. Auto-cleans with the controller. A handler throw reaches the root's `onError` as `kind: 'emitter'`. Since 1.0 the returned `dispose` also unlinks that cleanup, so an emitter disposed early leaves no entry on the controller (`packages/core/src/controller/instance.ts:642-650`). Pinned by `controller-regressions.test.ts`, "primitives disposed early release their controller registration".

Either form has the same shape.

## Implementation notes

- Handlers iterate over a **snapshot** (`Array.from(this.handlers)`) so a handler that unsubscribes itself or another mid-emit doesn't crash. The unsubscribed handler still runs for the current emit if it was in the snapshot — newly added handlers fire from the next emit onward.
- After `dispose()`, `emit` is a no-op and `on` and `once` return a no-op unsubscribe function.
- `emit` is typed conditionally: `T extends void` → zero-arg; otherwise one-arg.
