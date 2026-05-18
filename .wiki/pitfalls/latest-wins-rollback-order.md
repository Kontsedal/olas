---
name: latest-wins-rollback-order
description: For latest-wins mutations, roll back the previous snapshot BEFORE invoking the new onMutate. Order matters.
type: pitfall
covers:
  - packages/core/src/query/mutation.ts:60-80
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: uses, target: ../entities/mutation.md }
last_verified: 2026-05-18
confidence: high
---

# Latest-wins: roll back the previous snapshot synchronously, BEFORE the new `onMutate`

## The rule

Per spec §6.1: when a `latest-wins` mutation supersedes a previous run, the previous run's snapshot must be rolled back **before** the new `onMutate` is invoked. Otherwise the new optimistic update stacks on top of the obsolete one.

## The bug we hit

Original Phase 6 implementation only aborted on supersede, and the previous run's snapshot rollback happened lazily in that previous run's catch block (when the awaited promise rejected with AbortError):

```ts
// BAD — rollback happens after new run.onMutate
case 'latest-wins':
  for (const handle of this.inflight) handle.abort.abort()   # just abort
  return this.executeRun(vars)                               # new onMutate fires immediately
  // ...later, the old run's promise rejects with AbortError, its catch calls snapshot.rollback()
```

Sequence:
1. run #1: data was 1; onMutate(10) writes 10; snapshot[1] captures `prev=1`. Data is now 10.
2. run #2 (supersede): old run aborted (rollback queued). New onMutate(20) writes 20; snapshot[2] captures `prev=10`. Data is now 20.
3. Old run's await rejects. Its catch calls `snapshot[1].rollback()` — sets data back to `1` ← WRONG, we wanted `20`.

The test `onMutate snapshot is rolled back on supersede` reproduced this with `expected 20, got 1`.

## The fix

Roll back the previous snapshot **synchronously** before calling `executeRun`:

```ts
case 'latest-wins':
  // Spec §6.1: rollback the superseded run's snapshot BEFORE the new
  // run's onMutate runs, so the new optimistic update doesn't stack on
  // top of the obsolete one.
  for (const handle of this.inflight) {
    handle.abort.abort()
    handle.snapshot?.rollback()
    handle.snapshot = undefined   # prevent double-rollback in the old run's catch
  }
  return this.executeRun(vars)
```

Now:
1. run #1: data 1 → snapshot[1] → data 10.
2. run #2 starts: aborts run #1, rolls back snapshot[1] (data 10 → 1). Sets snapshot=undefined on run #1's handle so the eventual reject can't double-rollback.
3. New onMutate(20): snapshot[2] captures `prev=1` (the post-rollback state). Data: 1 → 20.
4. Old run's reject fires; its catch sees `snapshot === undefined`, no-op.

## When this matters

Only for `latest-wins` mutations with optimistic updates. `parallel` doesn't abort, `serial` doesn't overlap, both don't hit this.

## Test coverage

`packages/core/tests/mutation.test.ts > ctx.mutation — concurrency: latest-wins > onMutate snapshot is rolled back on supersede` — pins it. If anyone refactors `run` and rearranges this ordering, the test catches it.
