---
name: devtools
description: DebugEvent union + per-root DevtoolsEmitter. Free when no one is subscribed.
type: module
covers:
  - packages/core/src/devtools.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/devtools.test.ts }
  - { type: uses, target: ../entities/controller-instance.md }
last_verified: 2026-05-18
confidence: high
---

# `devtools.ts`

`DebugEvent` discriminated union (controller construct/suspend/resume/dispose, cache fetch lifecycle, mutation lifecycle, field validation) + `DevtoolsEmitter` class. Spec §14, §20.9, §21.8.

## DevtoolsEmitter

One per root. Held inside `RootShared.devtools`. Emits are routed from `ControllerInstance` and (eventually) from `QueryClient` / `MutationImpl` at the relevant lifecycle points.

- `emit(event)` — short-circuits when `handlers.size === 0` (one Set size check). So having the bus in production with no subscriber is effectively free.
- `subscribe(handler)` — fires on every event; returns unsub. Exposed publicly via `root.__debug.subscribe(...)`.
- Handler exceptions are caught — a buggy devtools handler must not break the program.
- Iterates over a snapshot, like `Emitter`.

## What's emitted today

`controller:constructed | suspended | resumed | disposed` are wired in `ControllerInstance`. The cache/mutation/field events listed in the union are reserved — emitting them is a future-Phase-13 task. The discriminated union is non-breaking to extend.
