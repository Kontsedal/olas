---
name: construction-rollback
description: When a controller factory throws, the partially-built state tears itself down — siblings stay alive.
type: flow
covers:
  - packages/core/src/controller/instance.ts:91-124
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/controller.test.ts }
  - { type: uses, target: ../entities/controller-instance.md }
last_verified: 2026-05-22
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
6. **`root.onError` only fires for construction errors AFTER the root is alive** — e.g. inside an effect that creates a lazy child, or inside a `ctx.collection`'s factory. Those go through `onError` with `kind: 'construction'`.

## Implementation

`ControllerInstance.construct(factory, props)`:

```ts
construct(factory, props): Api {
  const ctx = this.buildCtx()
  try {
    const api = factory(ctx, props)
    this.state = 'active'
    this.rootShared.devtools.emit({ type: 'controller:constructed', path, props })
    return api
  } catch (err) {
    this.rollbackPartialConstruction()
    throw err
  }
}

rollbackPartialConstruction(): void {
  for (let i = this.entries.length - 1; i >= 0; i--) {
    try { this.disposeEntry(this.entries[i]!) }
    catch { /* swallow — rollback can't escalate */ }
  }
  this.entries.length = 0
  this.state = 'disposed'
}
```

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
5. `parent`'s `construct` catches. `rollbackPartialConstruction()` reverse-iterates: disposes the `sibling` child (calling `sibling`'s `onDispose` hook). Re-throws.
6. `createRoot` rethrows the error to the caller.
