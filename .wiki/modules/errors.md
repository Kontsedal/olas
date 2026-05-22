---
name: errors
description: ErrorContext type + dispatchError function.
type: module
covers:
  - packages/core/src/errors.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/errors.test.ts }
last_verified: 2026-05-22
confidence: high
---

# `errors.ts`

`ErrorContext` describes where an error originated: `{ kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin', controllerPath, queryKey? }`. Spec §12, §20.9. `'plugin'` covers exceptions raised by `QueryClientPlugin` callbacks (cross-tab, entities, etc.) — SPEC §13.2.

`dispatchError(handler, err, context)` is used everywhere we catch a user callback that might throw. Calls the user `onError` if provided; falls back to `console.error`. If the handler itself throws, swallows and logs — the rule per spec §12 is "onError must never break the program."

This module is tiny but every primitive that runs user callbacks (`effect` body, `on` handler, `onSuspend/Resume/Dispose` hook, mutation lifecycle callbacks, plugin callbacks) routes through here so error reporting is consistent.
