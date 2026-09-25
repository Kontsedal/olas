---
name: controller-instance
description: The runtime object for a controller — owns the lifecycle list, builds the Ctx, resolves scopes for ctx.inject and root.inject.
type: entity
covers:
  - packages/core/src/controller/instance.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/scope.test.ts }
  - { type: uses, target: ctx.md }
  - { type: uses, target: scope.md }
  - { type: uses, target: ../flows/construction-rollback.md }
  - { type: related, target: ../modules/controller.md }
last_verified: 2026-09-25
confidence: high
---

# `ControllerInstance`

The runtime object for one controller. `createRoot` makes the root one, and `ctx.child`, `ctx.attach`, `ctx.collection` and `ctx.lazyChild` make the rest. Defined in `packages/core/src/controller/instance.ts:154-1089`.

## Fields

```ts nocheck
class ControllerInstance {
  readonly path: readonly string[]            // ['root', 'feature[0]', 'leaf[1]'] etc.
  readonly deps: Record<string, unknown>      // merged deps for this subtree
  private state: 'constructing' | 'active' | 'suspended' | 'disposed'
  private readonly entries: LifecycleList     // the cleanup list
  private readonly rootShared: RootShared     // devtools, onError, queryClient, queryDefaults, scopesVersion
  private readonly parent: ControllerInstance | null
  private childCounter = 0                    // used for path segment names
  private scopes: Map<Scope<unknown>, unknown> | null = null
  private injectCache: Map<Scope<unknown>, { value: unknown; version: number }> | null = null
  private debugValues: Record<string, unknown> | undefined   // ctx.debug, dev-only
  private debugPendingEmit: boolean   // a ctx.debug call while suspended; resume() sends it
}
```

`LifecycleList` (`instance.ts:108-152`) is a doubly-linked list of nodes. `push` returns the node, and `unlink(node)` removes it in O(1), which `attach`, `collection` and `lazyChild` use for children that come and go. `forward()` and `reverse()` capture the next node before they yield, so a push during traversal is safe.

## `LifecycleEntry` union

```ts nocheck
type LifecycleEntry =
  | { kind: 'effect';             factory: () => void | (() => void); dispose: (() => void) | null }
  | { kind: 'cleanup';            dispose: () => void }
  | { kind: 'subscription-cache'; dispose: () => void; suspend: () => void; resume: () => void }
  | { kind: 'child';              instance: ControllerInstance; explicitlySuspended?: boolean }
  | { kind: 'onDispose';          fn: () => void }
  | { kind: 'onSuspend';          fn: () => void }
  | { kind: 'onResume';           fn: () => void }
  | { kind: 'subscription';       unsubscribe: () => void }
```

The union is at `instance.ts:53-75`. `subscription-cache` is `createQuery(ctx, …)`'s entry. It is distinct from `cleanup` because `suspend()` and `resume()` must pause and restart the underlying `ClientEntry`: the `refetchInterval`, the focus and online listeners, and this subscriber's hold on the entry. Spec §4.1.

The free-function primitives register `cleanup` and `subscription-cache` entries through `CtxInternals.register` (`instance.ts:473-501`); `packages/core/src/controller/internals.ts:27-34` names the two shapes.

`factory` on the `effect` variant is the user's effect function, wrapped so a throw in it or in its cleanup reaches `onError` (`instance.ts:509-552`). The instance keeps it so suspend → resume can re-instantiate the effect through `standaloneEffect(factory)`.

## State transitions

| From | To | Method | Effect |
|------|----|--------|--------|
| constructing | active | `construct(factory, props)` | factory ran; api returned; emits `controller:constructed` with any `ctx.debug` values |
| constructing | disposed | factory throws | `rollbackPartialConstruction()` reverse-disposes the entries, then rethrows |
| active | suspended | `suspend()` | reverse loop: dispose effects and keep their factories, suspend `subscription-cache` entries, recurse into children, fire `onSuspend` |
| suspended | active | `resume()` | forward loop: re-instantiate effects, resume `subscription-cache` entries, recurse into children, fire `onResume` |
| any non-disposed | disposed | `dispose()` | reverse loop: dispatch by entry kind, then drop the scope maps |

The methods are at `instance.ts:247-451`. `dispose` is idempotent, `suspend` is a no-op unless `'active'`, and `resume` is a no-op unless `'suspended'`. A throw from one entry reaches `onError` as `kind: 'effect'` and the loop continues.

**A ctx method called after dispose throws** (T2.4). `assertLive` guards `effect`, `emitter`, `on`, `child`, `attach`, `collection`, `lazyChild` and the lifecycle hooks (`instance.ts:463-467`). A captured `ctx` used past its owner would otherwise push into a cleared list and leak a live effect or child.

**An effect registered while suspended waits for resume.** `ctx.effect` pushes the entry but activates it only when the state is not `'suspended'` (`instance.ts:545-551`).

**A handler that changes the state ends the pass (1.0).** Both loops re-check `state` before each entry. `suspend()` stops once it is no longer `'suspended'`, and `resume()` once it is no longer `'active'` (`instance.ts:349-352`, `instance.ts:390-394`). An `onResume` handler that disposed the controller, or suspended it again, used to let the loop carry on and switch the later effects back on. An `onSuspend` handler that disposed it let the remaining `onSuspend` handlers fire. The `controller:suspended` and `controller:resumed` devtools events are sent only if the pass ended in its own state. Pinned by `regressions.test.ts`, "W9 mutation-testing regressions".

**Resume re-activation guard (T2.2).** `resume()` sets `state = 'active'` before the forward loop. An effect registered *during* resume, such as one from an `onResume` handler calling `ctx.effect`, is therefore activated at once by `ctx.effect`, and its `dispose` is non-null. The loop then reaches that fresh node. The `effect` case re-activates **only when `entry.dispose === null`**, meaning only effects that `suspend()` cleared, so it never overwrites a live `dispose` ref (`instance.ts:397-409`). Without the guard the effect ran twice per change and one copy survived `dispose()`. Pinned by `regressions.test.ts` R-L2.2, and B9 covers the symmetric `onSuspend` case.

**Explicit-suspension flag (T2.6).** The `child` entry carries `explicitlySuspended?: boolean`. `attach.suspend()` and `collection.suspendItem()` set it, and `attach.resume()` and `resumeItem()` clear it. The `resume()` cascade skips a `child` entry with the flag set (`instance.ts:415-422`). A whole-tree resume from `SuspendOnUnmount` therefore does not wake a child that was explicitly suspended, such as a scrolled-out virtualized row. `attach.resume()` or `resumeItem()` called while the parent `isSuspended()` clears the flag but does NOT activate. The child rejoins the parent's next resume cascade instead of running inside a frozen tree. Pinned by `regressions.test.ts` R-L2.6.

## Scopes

`ctx.provide(scope, value)` stores the value on this instance, keyed by the scope object, and bumps `rootShared.scopesVersion` (`instance.ts:593-602`). `resolveScope(scope, caller)` backs both `ctx.inject` and `root.inject` (`instance.ts:198-229`). It walks this instance and its ancestors, falls back to the scope's default, and throws a message naming `caller` when neither exists. The result is memoized per scope in `injectCache`, stamped with the version it saw, so any `provide` in the tree invalidates every memo at once.

`seedScopes(bindings)` pre-seeds the root instance before its factory runs (`instance.ts:192-196`). `createRoot` calls it for plugin-provided scopes, then for `RootOptions.scopes`, so the explicit ones win.

## Path naming

`makeChildSegment(factory, explicitName)` produces `${name}[${index}]` (`instance.ts:1084-1088`). The name is `defineController`'s `name` option when given, else `factory.name`, else `'anonymous'`, and the counter is per parent. So `defineController(function userProfile(ctx) {…})` shows up as `['root', 'userProfile[0]']`, and an anonymous arrow factory as `['root', 'anonymous[0]']`. The devtools emitter and error contexts use `path`.

## `ctx.attach(def, props)` handle

Returns `{ api, dispose, suspend, resume }` (`instance.ts:641-709`). `dispose` tears the child down early and unlinks its entry from the parent, so a later parent dispose does not dispose it twice. `suspend` and `resume` cascade through the child's own lifecycle entries, the same code path as `root.suspend()` and `root.resume()`. All three are idempotent, and `suspend` and `resume` do nothing once the handle is disposed. Each wraps its work so a throw reaches `onError` with `kind: 'effect'`. `<SuspendOnUnmount controller={…}>` in `@kontsedal/olas-react` consumes `{ suspend, resume }` directly. Spec §4.1, §16.5.
