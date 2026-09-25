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
  - { type: tested-by, target: ../../packages/core/tests/controller-regressions.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/scope.test.ts }
  - { type: uses, target: ctx.md }
  - { type: uses, target: scope.md }
  - { type: uses, target: ../flows/construction-rollback.md }
  - { type: related, target: ../modules/controller.md }
last_verified: 2026-09-25
confidence: high
---

# `ControllerInstance`

The runtime object for one controller. `createRoot` makes the root one, and `ctx.child`, `ctx.attach`, `ctx.collection` and `ctx.lazyChild` make the rest. Defined in `packages/core/src/controller/instance.ts:155-1154`.

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

`LifecycleList` (`instance.ts:109-153`) is a doubly-linked list of nodes. `push` returns the node, and `unlink(node)` removes it in O(1), which `attach`, `collection` and `lazyChild` use for children that come and go. `forward()` and `reverse()` capture the next node before they yield, so a push during traversal is safe. An unlink during traversal is safe too. An unlinked node keeps its own `prev` and `next`, and both walks step past it without yielding it (1.0). A field's `dispose` unlinks its own entry while the controller disposes, and a form's `dispose` unlinks the entries of the fields it owns, which the walk has not reached yet.

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

The free-function primitives register `cleanup` and `subscription-cache` entries through `CtxInternals.register` (`instance.ts:509-538`); `packages/core/src/controller/internals.ts:27-34` names the two shapes. `register` returns a function that unlinks the entry. `createField`, `createForm` and `createFieldArray` call it from the node's own `dispose`, so an item a `FieldArray` drops leaves no entry behind (1.0). Before that, a churning array grew the list by one entry per item, and the controller's dispose called every dropped field's `dispose` a second time. Pinned by `form-regressions.test.ts`, "field arrays release the lifecycle entries of the items they drop".

`factory` on the `effect` variant is the user's effect function, wrapped so a throw in it or in its cleanup reaches `onError` (`instance.ts:546-596`). The instance keeps it so suspend → resume can re-instantiate the effect through `standaloneEffect(factory)`.

## State transitions

| From | To | Method | Effect |
|------|----|--------|--------|
| constructing | active | `construct(factory, props)` | factory ran; api returned; emits `controller:constructed` with any `ctx.debug` values |
| constructing | disposed | factory throws | `rollbackPartialConstruction()` reverse-disposes the entries, then rethrows |
| active | suspended | `suspend()` | reverse loop: dispose effects and keep their factories, suspend `subscription-cache` entries, recurse into children, fire `onSuspend` |
| suspended | active | `resume()` | forward loop: re-instantiate effects, resume `subscription-cache` entries, recurse into children, fire `onResume` |
| any non-disposed | disposed | `dispose()` | reverse loop: dispatch by entry kind, then drop the scope maps |

The methods are at `instance.ts:250-487`. `dispose` is idempotent, `suspend` is a no-op unless `'active'`, and `resume` is a no-op unless `'suspended'`. A throw from one entry reaches `onError` as `kind: 'effect'` and the loop continues.

**A ctx method called after dispose throws** (T2.4). `assertLive` guards `effect`, `emitter`, `on`, `child`, `attach`, `collection`, `lazyChild` and the lifecycle hooks (`instance.ts:499-503`). A captured `ctx` used past its owner would otherwise push into a cleared list and leak a live effect or child.

**An effect registered while suspended waits for resume.** `ctx.effect` pushes the entry but activates it only when the state is not `'suspended'` (`instance.ts:581-595`).

**An effect whose first run ends its owner is settled after that run (1.0).** The first run happens inside `standaloneEffect`, before the entry holds its disposer. A `dispose()` or `suspend()` pass that the run starts therefore cannot reach it. After the run, `ctx.effect` checks `isTerminal()` and `isSuspended()` (`instance.ts:585-594`). A disposed owner gets the effect stopped and not pushed, and a suspended one gets it stopped and pushed, so the resume re-runs it. The collection's reconcile effect does the same. Before this, such an effect kept running for the rest of the program. Pinned by `controller-regressions.test.ts`, "an effect whose first run disposes its owner".

**Every child goes through `constructChild` (1.0).** `ctx.child`, `attach`, the collection's `buildChild` and the `lazyChild` settle all build through it (`instance.ts:367-379`). It does three things. The factory runs inside `untracked`, as the collection's reconcile already did (T2.3). A child built inside an effect therefore adds nothing the factory reads to the effect's dependencies. A write to one of those signals no longer disposes and rebuilds the child. A parent disposed during the construction, for one by the child's own factory, returns `live: false` and disposes the child, so the caller registers nothing in the cleared list. A parent suspended by then gets the child suspended, so a child built from a `ctx.on` handler or a late `lazyChild` load does not run inside a frozen tree. That child is not explicitly suspended, so the parent's next resume wakes it. Pinned by `controller-regressions.test.ts`.

**A handler that changes the state ends the pass (1.0).** Both loops re-check `state` before each entry. `suspend()` stops once it is no longer `'suspended'`, and `resume()` once it is no longer `'active'` (`instance.ts:385-388`, `instance.ts:426-430`). An `onResume` handler that disposed the controller, or suspended it again, used to let the loop carry on and switch the later effects back on. An `onSuspend` handler that disposed it let the remaining `onSuspend` handlers fire. The `controller:suspended` and `controller:resumed` devtools events are sent only if the pass ended in its own state. Pinned by `regressions.test.ts`, "W9 mutation-testing regressions".

**Resume re-activation guard (T2.2).** `resume()` sets `state = 'active'` before the forward loop. An effect registered *during* resume, such as one from an `onResume` handler calling `ctx.effect`, is therefore activated at once by `ctx.effect`, and its `dispose` is non-null. The loop then reaches that fresh node. The `effect` case re-activates **only when `entry.dispose === null`**, meaning only effects that `suspend()` cleared, so it never overwrites a live `dispose` ref (`instance.ts:433-445`). Without the guard the effect ran twice per change and one copy survived `dispose()`. Pinned by `regressions.test.ts` R-L2.2, and B9 covers the symmetric `onSuspend` case.

**Explicit-suspension flag (T2.6).** The `child` entry carries `explicitlySuspended?: boolean`. `attach.suspend()` and `collection.suspendItem()` set it, and `attach.resume()` and `resumeItem()` clear it. The `resume()` cascade skips a `child` entry with the flag set (`instance.ts:451-458`). A whole-tree resume from `SuspendOnUnmount` therefore does not wake a child that was explicitly suspended, such as a scrolled-out virtualized row. `attach.resume()` or `resumeItem()` called while the parent `isSuspended()` clears the flag but does NOT activate. The child rejoins the parent's next resume cascade instead of running inside a frozen tree. Pinned by `regressions.test.ts` R-L2.6.

## Scopes

`ctx.provide(scope, value)` stores the value on this instance, keyed by the scope object, and bumps `rootShared.scopesVersion` (`instance.ts:637-646`). `resolveScope(scope, caller)` backs both `ctx.inject` and `root.inject` (`instance.ts:199-230`). It walks this instance and its ancestors, falls back to the scope's default, and throws a message naming `caller` when neither exists. The result is memoized per scope in `injectCache`, stamped with the version it saw, so any `provide` in the tree invalidates every memo at once.

`seedScopes(bindings)` pre-seeds the root instance before its factory runs (`instance.ts:193-197`). `createRoot` calls it for plugin-provided scopes, then for `RootOptions.scopes`, so the explicit ones win.

## Path naming

`makeChildSegment(factory, explicitName)` produces `${name}[${index}]` (`instance.ts:1149-1153`). The name is `defineController`'s `name` option when given, else `factory.name`, else `'anonymous'`, and the counter is per parent. So `defineController(function userProfile(ctx) {…})` shows up as `['root', 'userProfile[0]']`, and an anonymous arrow factory as `['root', 'anonymous[0]']`. The devtools emitter and error contexts use `path`.

## `ctx.attach(def, props)` handle

Returns `{ api, dispose, suspend, resume }` (`instance.ts:685-757`). `dispose` tears the child down early and unlinks its entry from the parent, so a later parent dispose does not dispose it twice. `suspend` and `resume` cascade through the child's own lifecycle entries, the same code path as `root.suspend()` and `root.resume()`. All three are idempotent, and `suspend` and `resume` do nothing once the handle is disposed. Each wraps its work so a throw reaches `onError` with `kind: 'effect'`. `<SuspendOnUnmount controller={…}>` in `@kontsedal/olas-react` consumes `{ suspend, resume }` directly. Spec §4.1, §16.5.
