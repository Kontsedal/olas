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

The runtime object for one controller. `createRoot` makes the root one, and `ctx.child`, `ctx.attach`, `ctx.collection` and `ctx.lazyChild` make the rest. Defined in `packages/core/src/controller/instance.ts:158-1237`.

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

`LifecycleList` (`instance.ts:112-156`) is a doubly-linked list of nodes. `push` returns the node, and `unlink(node)` removes it in O(1), which `attach`, `collection` and `lazyChild` use for children that come and go. `forward()` and `reverse()` capture the next node before they yield, so a push during traversal is safe. An unlink during traversal is safe too. An unlinked node keeps its own `prev` and `next`, and both walks step past it without yielding it (1.0). A field's `dispose` unlinks its own entry while the controller disposes, and a form's `dispose` unlinks the entries of the fields it owns, which the walk has not reached yet.

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

The union is at `instance.ts:60-78`, and its `effect` variant is `EffectEntry` (`instance.ts:54-58`). `subscription-cache` is `createQuery(ctx, …)`'s entry. It is distinct from `cleanup` because `suspend()` and `resume()` must pause and restart the underlying `ClientEntry`: the `refetchInterval`, the focus and online listeners, and this subscriber's hold on the entry. Spec §4.1.

The free-function primitives register `cleanup` and `subscription-cache` entries through `CtxInternals.register` (`instance.ts:540-569`); `packages/core/src/controller/internals.ts:27-34` names the two shapes. `register` returns a function that unlinks the entry. `createField`, `createForm` and `createFieldArray` call it from the node's own `dispose`, so an item a `FieldArray` drops leaves no entry behind (1.0). Before that, a churning array grew the list by one entry per item, and the controller's dispose called every dropped field's `dispose` a second time. Pinned by `form-regressions.test.ts`, "field arrays release the lifecycle entries of the items they drop".

`createCache` and `createMutation` do the same through a wrapped `dispose` on the object they return, since `local.ts` and `mutation.ts` have no dispose hook (`packages/core/src/query/bind.ts:126-136`, `packages/core/src/query/bind.ts:194-200`). The cache's wrapper also takes it out of `RootShared.localCaches`. `ctx.emitter` wraps its emitter's `dispose` to unlink its node (`instance.ts:656-664`). Before this, the Map pattern of spec §3.4 grew the list by one entry per dropped cache, mutation or emitter, and the root's dispose disposed each again. Pinned by `controller-regressions.test.ts`, "primitives disposed early release their controller registration".

`factory` on the `effect` variant is the user's effect function, wrapped so a throw in it or in its cleanup reaches `onError` (`instance.ts:577-619`). The instance keeps it so suspend → resume can re-instantiate the effect through `standaloneEffect(factory)`.

## State transitions

| From | To | Method | Effect |
|------|----|--------|--------|
| constructing | active | `construct(factory, props)` | factory ran; api returned; emits `controller:constructed` with any `ctx.debug` values |
| constructing | disposed | factory throws | marks the throw as a construction error; `rollbackPartialConstruction()` sets `'disposed'`, reverse-disposes the entries, then rethrows |
| active | suspended | `suspend()` | reverse loop: dispose effects and keep their factories, suspend `subscription-cache` entries, recurse into children, fire `onSuspend` |
| suspended | active | `resume()` | forward loop: re-instantiate effects, resume `subscription-cache` entries, recurse into children, fire `onResume` |
| any non-disposed | disposed | `dispose()` | reverse loop: dispatch by entry kind; the scope maps stay |

The methods are at `instance.ts:258-518`. `dispose` is idempotent, `suspend` is a no-op unless `'active'`, and `resume` is a no-op unless `'suspended'`. A throw from one entry reaches `onError` as `kind: 'effect'` and the loop continues.

**A rollback is disposed before its teardown runs (1.0).** `rollbackPartialConstruction` sets `state = 'disposed'` before its loop, as `dispose()` does (`instance.ts:291-309`). It used to set it after the loop. A teardown that called `ctx.effect` or `ctx.child`, such as `ctx.onDispose(() => ctx.effect(...))` in a factory that then threw, registered into the list `clear()` dropped, and the new effect ran on for good. Now `assertLive` throws there, and the throw reaches `onError` through the hook's wrapper. Pinned by `controller-regressions.test.ts`, "a rollback does not let a teardown build new primitives".

**A factory throw is marked as a construction error (1.0).** `construct` passes the throw to `markConstructionError` before it rolls back (`instance.ts:271`). `dispatchError` then reports it as `kind: 'construction'`, whichever callback caught it: an effect that called `ctx.child`, a `ctx.on` handler that called `ctx.attach`, a mutation hook. §12.1.6 names the effect case. It reached `onError` as `'effect'` or `'emitter'` before. See `../modules/errors.md`.

**A ctx method called after dispose throws** (T2.4). `assertLive` guards `effect`, `emitter`, `on`, `child`, `attach`, `collection`, `lazyChild` and the lifecycle hooks (`instance.ts:530-534`). A captured `ctx` used past its owner would otherwise push into a cleared list and leak a live effect or child.

**An effect registered while suspended waits for resume.** `ctx.effect` pushes the entry but activates it only when the state is not `'suspended'` (`instance.ts:612-618`).

**An effect run that ends its owner is settled after that run (1.0).** Every start of an effect goes through `startEffect` (`instance.ts:369-381`): `ctx.effect`'s first run, a collection's first reconcile, and the re-run `resume()` starts. The run happens inside `standaloneEffect`, before the entry holds its disposer. A `dispose()` or `suspend()` pass that the run starts therefore cannot reach it. After the run, `startEffect` checks `isTerminal()` and `isSuspended()`, and stops the effect when either holds. `ctx.effect` then pushes the entry only for a live owner, so a suspended owner's resume re-runs it. A nested suspend and resume inside the run may have restarted the entry already, and `startEffect` keeps that copy rather than overwrite a live disposer. Before this, such an effect kept running for the rest of the program, or inside a suspended tree. The resume case was the last gap: `ctx.effect(() => { if (expired.value) root.dispose() })` kept running after a `resume()` that disposed the root. It covers a child woken by an `attach` handle's `resume()` too, which runs the same `resume()`. Pinned by `controller-regressions.test.ts`, "an effect whose first run disposes its owner" and "an effect whose re-run on resume ends its owner".

**Every child goes through `constructChild` (1.0).** `ctx.child`, `attach`, the collection's `buildChild` and the `lazyChild` settle all build through it (`instance.ts:400-412`). It does three things. The factory runs inside `untracked`, as the collection's reconcile already did (T2.3). A child built inside an effect therefore adds nothing the factory reads to the effect's dependencies. A write to one of those signals no longer disposes and rebuilds the child. A parent disposed during the construction, for one by the child's own factory, returns `live: false` and disposes the child, so the caller registers nothing in the cleared list. A parent suspended by then gets the child suspended once its factory returns. So a child built from a `ctx.on` handler or a late `lazyChild` load has run its effects once, and its queries may have started a fetch, before it goes still (spec §4.1). That child is not explicitly suspended, so the parent's next resume wakes it. Pinned by `controller-regressions.test.ts`.

**A handler that changes the state ends the pass (1.0).** Both loops re-check `state` before each entry. `suspend()` stops once it is no longer `'suspended'`, and `resume()` once it is no longer `'active'` (`instance.ts:418-421`, `instance.ts:459-463`). An `onResume` handler that disposed the controller, or suspended it again, used to let the loop carry on and switch the later effects back on. An `onSuspend` handler that disposed it let the remaining `onSuspend` handlers fire. The `controller:suspended` and `controller:resumed` devtools events are sent only if the pass ended in its own state. Pinned by `regressions.test.ts`, "W9 mutation-testing regressions".

**Resume re-activation guard (T2.2).** `resume()` sets `state = 'active'` before the forward loop. An effect registered *during* resume, such as one from an `onResume` handler calling `ctx.effect`, is therefore activated at once by `ctx.effect`, and its `dispose` is non-null. The loop then reaches that fresh node. The `effect` case re-activates **only when `entry.dispose === null`**, meaning only effects that `suspend()` cleared, so it never overwrites a live `dispose` ref (`instance.ts:466-476`). The restart goes through `startEffect`. Without the guard the effect ran twice per change and one copy survived `dispose()`. Pinned by `regressions.test.ts` R-L2.2, and B9 covers the symmetric `onSuspend` case.

**Explicit-suspension flag (T2.6).** The `child` entry carries `explicitlySuspended?: boolean`. `attach.suspend()` and `collection.suspendItem()` set it, and `attach.resume()` and `resumeItem()` clear it. The `resume()` cascade skips a `child` entry with the flag set (`instance.ts:482-489`). A whole-tree resume from `SuspendOnUnmount` therefore does not wake a child that was explicitly suspended, such as a scrolled-out virtualized row. A collection key rebuilt for a new controller type carries the flag to the new child, which is built suspended (1.0). `attach.resume()` or `resumeItem()` called while the parent `isSuspended()` clears the flag but does NOT activate. The child rejoins the parent's next resume cascade instead of running inside a frozen tree. Pinned by `regressions.test.ts` R-L2.6.

## Scopes

`ctx.provide(scope, value)` stores the value on this instance, keyed by the scope object, and bumps `rootShared.scopesVersion` (`instance.ts:667-676`). `resolveScope(scope, caller)` backs both `ctx.inject` and `root.inject` (`instance.ts:202-238`). It walks this instance and its ancestors, falls back to the scope's default, and throws a message naming `caller` when neither exists. The result is memoized per scope in `injectCache`, stamped with the version it saw, so any `provide` in the tree invalidates every memo at once.

**Inject after dispose returns what it resolved while live (1.0).** `dispose()` keeps `scopes` and `injectCache`, and a disposed instance returns a memoized value without the version check (`instance.ts:210-215`). A scope it never read walks the kept maps. §4 says reads do not throw after dispose. `dispose()` used to null both maps, so `ctx.inject` and `root.inject` threw "no provider" once the controller was gone. Pinned by `controller-regressions.test.ts`, "inject after dispose". A disposed instance holds its provided values until the instance itself is unreachable, which is when the `ctx` that closes over it is.

`seedScopes(bindings)` pre-seeds the root instance before its factory runs (`instance.ts:196-200`). `createRoot` calls it for plugin-provided scopes, then for `RootOptions.scopes`, so the explicit ones win.

## Path naming

`makeChildSegment(factory, explicitName)` produces `${name}[${index}]` (`instance.ts:1232-1236`). The name is `defineController`'s `name` option when given, else `factory.name`, else `'anonymous'`, and the counter is per parent. So `defineController(function userProfile(ctx) {…})` shows up as `['root', 'userProfile[0]']`, and an anonymous arrow factory as `['root', 'anonymous[0]']`. The devtools emitter and error contexts use `path`.

## `ctx.attach(def, props)` handle

Returns `{ api, dispose, suspend, resume }` (`instance.ts:715-787`). `dispose` tears the child down early and unlinks its entry from the parent, so a later parent dispose does not dispose it twice. `suspend` and `resume` cascade through the child's own lifecycle entries, the same code path as `root.suspend()` and `root.resume()`. All three are idempotent, and `suspend` and `resume` do nothing once the handle is disposed. Each wraps its work so a throw reaches `onError` with `kind: 'effect'`. `<SuspendOnUnmount controller={…}>` in `@kontsedal/olas-react` consumes `{ suspend, resume }` directly. Spec §4.1, §16.5.
