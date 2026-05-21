---
name: controller-instance
description: The runtime object for a controller — owns the LifecycleEntry list and the Ctx factory.
type: entity
covers:
  - packages/core/src/controller/instance.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: uses, target: ctx.md }
  - { type: uses, target: ../flows/construction-rollback.md }
  - { type: related, target: ../modules/controller.md }
last_verified: 2026-05-21
confidence: high
---

# `ControllerInstance`

The runtime object for one controller. `createRoot` and `ctx.child` both produce one. Defined in `controller/instance.ts`.

## Fields

```ts
class ControllerInstance {
  readonly path: readonly string[]           # ['root', 'feature[0]', 'leaf[1]'] etc.
  readonly deps: Record<string, unknown>     # merged deps for this subtree
  private state: 'constructing' | 'active' | 'suspended' | 'disposed'
  private readonly entries: LifecycleEntry[] # the cleanup list
  private readonly rootShared: RootShared    # devtools, onError, queryClient
  private readonly parent: ControllerInstance | null
  private childCounter = 0                   # used for path segment names
  private scopes: Map<symbol, unknown> | null = null   # ctx.provide/inject backing store
}
```

## `LifecycleEntry` union

```ts
type LifecycleEntry =
  | { kind: 'effect',             factory: () => void | (() => void), dispose: (() => void) | null }
  | { kind: 'cleanup',            dispose: () => void }
  | { kind: 'subscription-cache', dispose: () => void, suspend: () => void, resume: () => void }
  | { kind: 'child',              instance: ControllerInstance }
  | { kind: 'subscription',       unsubscribe: () => void }
  | { kind: 'onDispose',          fn: () => void }
  | { kind: 'onSuspend',          fn: () => void }
  | { kind: 'onResume',           fn: () => void }
```

`subscription-cache` is `ctx.use(...)`'s entry — distinct from `cleanup` because `suspend()` / `resume()` need to pause/restart the underlying `ClientEntry` (refetchInterval + focus/online listeners + release of the entry from this subscriber). Spec §4.1.

`factory` on the `effect` variant is the user's effect function (wrapped with `dispatchError`). We retain it so suspend → resume can re-instantiate the effect via `standaloneEffect(factory)`.

## State transitions

| From | To | Method | Effect |
|------|----|--------|--------|
| constructing | active | `construct(factory, props)` | factory ran; api returned; emits `controller:constructed` |
| constructing | disposed | factory throws | `rollbackPartialConstruction()` — reverse-dispose entries; rethrow |
| active | suspended | `suspend()` | reverse-iterate: dispose effects (keep factory), recurse children, fire `onSuspend` |
| suspended | active | `resume()` | forward-iterate: re-instantiate effects, recurse children, fire `onResume` |
| any non-disposed | disposed | `dispose()` | reverse-iterate: dispatch by entry kind |

`dispose` is idempotent — re-entries return early.

## Path naming

`makeChildSegment(factory)` produces `${factory.name || 'anonymous'}[${index}]`. The counter is per-parent. So `defineController(function userProfile(ctx) {...})` makes children show up as `['root', 'userProfile[0]']`. Anonymous arrow factories get `['root', 'anonymous[0]']`. The DevtoolsEmitter uses `path` for its events.

## `ctx.attach(def, props)` handle

Returns `{ api, dispose, suspend, resume }`. `dispose` tears the child down early and removes the lifecycle entry from the parent (so a later parent-dispose doesn't double-dispose). `suspend` / `resume` cascade through the child's own lifecycle entries — same code path as `root.suspend()` / `root.resume()`. All four are idempotent and try/catch-wrapped via `dispatchError` with `kind: 'effect'`. `<KeepAlive controller={...}>` in `@kontsedal/olas-react` consumes `{ suspend, resume }` directly. Spec §4.1, §16.5.
