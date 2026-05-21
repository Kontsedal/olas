---
name: devtools
description: DebugEvent union + per-root DevtoolsEmitter. Free when no one is subscribed.
type: module
covers:
  - packages/core/src/devtools.ts
  - packages/core/src/query/entry.ts:5-9
  - packages/core/src/query/client.ts:48-102
  - packages/core/src/query/mutation.ts:109-165
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/devtools.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/devtools-events.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/dev-flag.test.ts }
  - { type: uses, target: ../entities/controller-instance.md }
  - { type: related, target: devtools-panel.md }
last_verified: 2026-05-21
confidence: high
---

# `devtools.ts`

`DebugEvent` discriminated union (controller construct/suspend/resume/dispose, cache fetch lifecycle, mutation lifecycle, field validation) + `DevtoolsEmitter` class. Spec §14, §20.9, §21.8.

## DevtoolsEmitter

One per root. Held inside `RootShared.devtools`. Emits are routed from `ControllerInstance`, from `QueryClient` (invalidate / gc), and from inside `Entry` / `MutationImpl` at the relevant lifecycle points.

- `emit(event)` — short-circuits when `handlers.size === 0` (one Set size check). So having the bus in production with no subscriber is effectively free.
- `subscribe(handler)` — fires on every event; returns unsub. Exposed publicly via `root.__debug.subscribe(...)`.
- Handler exceptions are caught — a buggy devtools handler must not break the program.
- Iterates over a snapshot, like `Emitter`.
- **Production builds** strip every `emit(...)` call site via tsdown's
  `define: { __DEV__: 'false' }` substitution. The bus itself remains
  exported — `subscribe(handler)` still works and returns a no-op unsub so
  consumer code doesn't need a build flag — but no events ever arrive. The
  four `controller:*` lifecycle hooks that feed `recordLifecycle` are
  inside the same guard, so the live-controller snapshot is empty too.
  See SPEC §23 *Devtools / `__debug` and production builds*.

## How events reach the bus

Lifecycle events from `ControllerInstance` go straight through `rootShared.devtools.emit(...)` — see `instance.ts:101-107, 145-147, 213-215, 250-252` (each call site wrapped in `if (__DEV__)` so production builds elide it; see SPEC §23 *Devtools / `__debug` and production builds*).

**Cache events** (Phase 13). `QueryClient` holds a `devtools?: DevtoolsEmitter`. `ClientEntry`'s constructor builds an `EntryEvents` callback bundle and passes it to `Entry`. `Entry` fires `onFetchStart` in `startFetch()`, `onFetchSuccess(durationMs)` in `applySuccess()`, `onFetchError(durationMs, error)` in `applyFailure()`. The bundle is `undefined` if `devtools` is `undefined`, so the cost when no devtools is one extra constructor field. `QueryClient.invalidate` / `invalidateAll` / `dropEntry` emit directly.

**Mutation events** (Phase 13). `MutationImpl` takes an optional `DevtoolsEmitter` constructor argument from `ctx.mutation` (via `instance.ts`). `mutation:run` fires after `onMutate` succeeds and counters are bumped. `mutation:success` fires before user `onSuccess`. `mutation:error` fires before user `onError`. `mutation:rollback` fires via a wrapped `Snapshot` — both the auto-rollback paths (supersede / dispose) AND any user-driven `snapshot.rollback()` from inside `onError` emit it, exactly once per snapshot.

**Field validation events** are wired. `ctx.field` calls `bindFieldDevtoolsOwner` so standalone fields publish `field:validated` with the owning controller path + a synthetic `(field)` name. `ctx.form` / `ctx.fieldArray` walk their trees via `bindTreeToDevtools` to publish events with the leaf's dotted path inside the form. See `forms/field.ts` (`bindFieldDevtoolsOwner`) and `forms/form.ts` (`bindTreeToDevtools`).

## What's emitted today

| Event family | Status |
|---|---|
| `controller:constructed / suspended / resumed / disposed` | ✓ wired in `ControllerInstance` |
| `cache:fetch-start / fetch-success / fetch-error` | ✓ wired via `EntryEvents` |
| `cache:invalidated / gc` | ✓ wired in `QueryClient` |
| `cache:subscribed` | declared, not yet wired |
| `mutation:run / success / error / rollback` | ✓ wired in `MutationImpl` |
| `field:validated` | ✓ wired via `bindFieldDevtoolsOwner` / `bindTreeToDevtools` |

The discriminated union is non-breaking to extend — consumers `switch` on `type` and ignore unknowns.
