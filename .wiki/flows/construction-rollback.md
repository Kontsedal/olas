---
name: construction-rollback
description: When a controller factory throws, the partially-built state tears itself down — siblings stay alive.
type: flow
covers:
  - packages/core/src/controller/instance.ts:258-311
  - packages/core/src/controller/root.ts:88-103
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/controller-regressions.test.ts }
  - { type: uses, target: ../entities/controller-instance.md }
last_verified: 2026-09-25
confidence: high
---

# Flow: construction error rollback

Spec §12.1 has the formal semantics. Summary:

## The rules

1. **The throwing controller is not constructed.** Its API never returns; `ctx.child(...)` re-throws synchronously.
2. **Already-constructed siblings stay alive.** A parent that constructed three children before the fourth's factory threw doesn't tear them down.
3. **The throw propagates up.** If the parent's factory called `ctx.child` and didn't catch, the parent's factory now throws too.
4. **Partially-constructed parents are rolled back.** When a parent's factory throws, every primitive and child the parent already created is disposed in reverse order of creation.
5. **`createRoot` does NOT swallow.** Bootstrap failures throw out of `createRoot` — `root.onError` is NOT invoked.
6. **`root.onError` only fires for construction errors AFTER the root is alive** — e.g. inside an effect that creates a lazy child, or inside a `ctx.collection`'s factory. Those go through `onError` with `kind: 'construction'`. The kind follows the throw: `construct` marks it, and `dispatchError` reports a marked error as `'construction'` whichever callback caught it (1.0). A factory that throws a string cannot be marked and keeps the caller's kind.
7. **A teardown during the rollback cannot build.** The rollback sets `'disposed'` first, so a hook that calls `ctx.effect` or `ctx.child` throws at `assertLive`, and the throw reaches `onError` (1.0).

## Implementation

`ControllerInstance.construct(factory, props, beforeRollback?)` (`instance.ts:258-289`):

```ts nocheck
construct(factory, props, beforeRollback?): Api {
  const ctx = this.buildCtx()
  let api
  try {
    api = factory(ctx, props)
  } catch (err) {
    markConstructionError(err)   // dispatchError reports it as 'construction' later
    beforeRollback?.()
    this.rollbackPartialConstruction()
    throw err
  }
  this.state = 'active'
  this.rootShared.devtools.emit({ type: 'controller:constructed', path, props })
  return api
}

rollbackPartialConstruction(): void {
  this.state = 'disposed'        // first, as in dispose(): a teardown cannot register
  for (const entry of this.entries.reverse()) {
    try { this.disposeEntry(entry) }
    catch (err) { dispatchError(onError, err, { kind: 'effect', controllerPath }) }
  }
  this.entries.clear()
}
```

A teardown throw during the rollback reaches `onError` and the rollback carries on, so it neither masks the construction error nor stops the rest (T2.8).

The state moves to `'disposed'` before the loop (1.0). It used to move after it. A teardown that built a primitive, such as `ctx.onDispose(() => ctx.effect(...))` in a factory that then threw, pushed into the list `clear()` dropped, and the effect ran on for good. Pinned by `controller-regressions.test.ts`, "a rollback does not let a teardown build new primitives".

`createRoot` passes a `beforeRollback` that calls `plugins.close()` and `queryClient.close()` (`root.ts:93-103`). Plugin delivery and the client therefore close before the rollback, so a failed bootstrap tears down in the order `root.dispose()` uses. Without it, a plugin heard the rollback's events, such as a query entry deactivating, and only then got disposed. Pinned by `controller-regressions.test.ts`, "plugins stop hearing events before the rollback, as they do on dispose".

`ctx.child(def, props)` re-throws synchronously; the child's own `construct` already rolled back its partial state.

If a parent has a try/catch around `ctx.child(...)`, it can swallow the throw. The failed child is gone; the parent's other entries (created before AND after the swallowed throw) stay live. The test `a parent that catches a child throw keeps successful siblings alive` (`controller.test.ts`) pins this.

## A worked example

```ts
const broken = defineController(() => { throw new Error('broken') })
const sibling = defineController((ctx) => { ctx.onDispose(/* ... */); return { ok: true } })
const parent = defineController((ctx) => {
  ctx.child(sibling, undefined)
  ctx.child(broken, undefined)  # throws here
  return {}
})
createRoot(parent, { deps })  # throws Error('broken')
```

Flow:
1. `parent`'s factory runs. Creates a `child` entry for `sibling` (successfully).
2. Calls `ctx.child(broken, undefined)`. `broken`'s factory throws.
3. `broken`'s `construct` rolls back (it had no entries, so nothing to dispose). Throws.
4. Back in `parent`'s factory, the throw propagates out of `ctx.child(broken)`.
5. `parent`'s `construct` catches. Its `beforeRollback` closes plugin delivery and the query client. `rollbackPartialConstruction()` reverse-iterates: disposes the `sibling` child (calling `sibling`'s `onDispose` hook). Re-throws.
6. `createRoot` disposes the plugins and the query client, then rethrows the error to the caller.
