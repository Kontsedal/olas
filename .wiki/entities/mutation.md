---
name: mutation
description: MutationImpl — three concurrency modes, optimistic + positional rollback, abort-race.
type: entity
covers:
  - packages/core/src/query/mutation.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/mutation-plugin-events.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/mutation-cancel-devtools.test.ts }
  - { type: uses, target: entry.md }
  - { type: uses, target: ../flows/mutation-concurrency.md }
  - { type: related, target: ../pitfalls/latest-wins-rollback-order.md }
  - { type: related, target: ../pitfalls/raceabort-for-misbehaving-mutate.md }
last_verified: 2026-09-25
confidence: high
---

# `MutationImpl<V, R>`

A controller-scoped async write with first-class loading state, optimistic updates, concurrency policy, and retry. Spec §6, §20.5.

## Public surface

```ts
type Mutation<V, R> = {
  run: (vars: V) => Promise<R>
  data: ReadSignal<R | undefined>
  error: ReadSignal<unknown | undefined>
  isPending: ReadSignal<boolean>
  status: ReadSignal<'idle' | 'pending' | 'success' | 'error'>
  lastVariables: ReadSignal<V | undefined>
  reset(): void
  dispose(): void
}
```

`MutationSpec` also carries `detached?: boolean` (§6.5) — see "Dispose" below.

`status` (T4.2) is the outcome of the latest run. React's `useMutation` derives `isIdle`, `isSuccess` and `isError` from it, so a `void` mutation that resolves `undefined` still reports `'success'` rather than looking stuck at `'idle'`. The old React heuristic read `data !== undefined`. `status` is distinct from `isPending`, which is true while *any* run is in flight in parallel mode. A superseded `latest-wins` run does NOT flip `status` to `'error'`, because the superseder owns it.

## Concurrency modes

| mode | semantics |
|------|-----------|
| `parallel` *(default)* | every `run()` is independent; `isPending` true if any inflight; `data`/`error` reflect the most-recent completion |
| `latest-wins` | new `run()` aborts every inflight AND **synchronously rolls back their snapshots BEFORE invoking the new `onMutate`** (see `../pitfalls/latest-wins-rollback-order.md`) |
| `serial` | queue; one at a time in order; a run that waits reports `'queued'` to plugins at once; `dispose` rejects queued runs with AbortError |

## `executeRun(vars)` — the core path

```
1. handle = { abort }; inflight.add(handle)   # before onMutate, so a dispose/reset/supersede it triggers aborts this run
2. onMutate(vars) → snapshot
   if signal.aborted: snapshot?.rollback(); leave(handle); throw AbortError   # mutate never runs; no plugin event unless queued
3. handle.snapshot = snapshot; inflightCounter.update(n => n+1)   # routes to client.mutationsInflight$
4. isPending = true; status = 'pending'; lastVariables = vars
5. try:
   result = await raceAbort(runWithRetry(vars, abort.signal), abort.signal)
   if aborted/disposed: snapshot?.finalize(); settle 'success'; throw AbortError
   data = result; error = undefined; status = 'success'
   onSuccess(result, vars)
   onSettled(result, undefined, vars)
   return result
6. catch err:
   if signal.aborted: snapshot?.rollback(); throw   # supersede — no error/status/onError/onSettled
   error = err; status = 'error'                   # includes an AbortError mutate threw with the signal live
   onError(err, vars, snapshot)
   onSettled(undefined, err, vars)
   throw
7. finally:
   leave(handle)   # inflight.delete; the last one out clears isPending
   inflightCounter.update(n => n-1)
   if inflight.size === 0: isPending = false
```

Notes:
- **`raceAbort(promise, signal)`** — if the user's `mutate` ignores its `AbortSignal`, the wrapper still rejects with AbortError when superseded. Without this, misbehaving fetchers could leave runs hanging forever. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.
- **Supersede ≠ failure.** AbortError doesn't populate `mutation.error`, doesn't invoke `onError`, doesn't invoke `onSettled`. Spec §6.1 is explicit.
- **Only the run's own signal makes it a supersede (1.0).** An `AbortError` that `mutate` throws while the run's signal is still live came from the work itself, for example a request it cancelled on its own. It is a failure: `status: 'error'`, `onError`, rollback, and `'error'` to plugins. The classifier used to test `isAbortError(err)` first. Such a run then counted as a cancellation, left `status` at `'pending'`, and told the mutation queue to keep the entry for replay. `Entry` makes the same split for fetchers (`entry.md`). Pinned by `regressions.test.ts`, "W9 mutation-testing regressions".
- **The handle is registered before `onMutate` (1.0).** A `dispose()`, `reset()` or `latest-wins` supersede triggered from inside `onMutate` therefore aborts the run: the optimistic write rolls back, `mutate` is never called, and plugins hear nothing, since no `start` was reported. A `serial` run that reported `'queued'` is the exception: it reports `'cancel'`, or `'error'` when its `onMutate` throws, so its `'queued'` gets an outcome. Registered after `onMutate`, the abort found nothing to cancel, `mutate` ran with a signal that never fired, and `status` stayed `'pending'`.
- **`onMutate` runs synchronously in `run()`** before the await. Snapshots are recorded before any I/O.
- **A run that COMPLETED is never rolled back** (2026-09-03). Reaching the post-await branch means `raceAbort` *resolved* — the work finished and the abort landed in the gap before the continuation. You cannot cancel what already happened, so the branch finalizes instead of rolling back. A rollback would commit a knowingly stale value to a cache that outlives the mutation, and the `onSuccess` that normally invalidates is skipped on this path. A persistable run settles `'success'` rather than `'cancel'`, because a `'cancel'` with reason `'dispose'` tells `@kontsedal/olas-mutation-queue` to KEEP the durable entry and replay it later. That would be a second write of a request the server accepted. The promise still rejects with `AbortError`. A `latest-wins` supersede consumed its snapshot back in `run()`, so the finalize is a no-op there. Pinned in `mutation.test.ts` ("a run that COMPLETED before dispose finalizes its snapshot") and `mutation-queue/tests/plugin.test.ts`.
- **Snapshots are wrapped single-consume.** `wrapSnapshot` makes `rollback()` and `finalize()` idempotent across each other, so whichever fires first wins. On success the path auto-calls `snapshot.finalize()`, which clears `hasPendingMutations`. On error it auto-calls `snapshot.rollback()` after the user's `onError`, and that is a no-op when `onError` already called `rollback`. Spec §6.4.

## Retry

`runWithRetry` follows the same shape as `Entry.runWithRetry`: catch err → check `shouldRetry(retry, attempt, err)` → `await abortableSleep(...)` → retry. The user-facing promise resolves with the final outcome. Only a function `retry` is called; a number caps the attempts, and anything else, `retry: false` included, never retries (spec §5.2). The loop used to call any non-number, so `retry: false` failed the run with "retry is not a function" in place of the error `mutate` threw. Pinned by `mutation.test.ts`, "retry: false never retries". `abortableSleep` schedules via `scheduleExpiry`, so a user `retryDelay` past the 32-bit timer limit backs off for the time asked instead of overflowing to ~1ms, and a non-finite one parks until the abort fires.

## What plugins and devtools hear on a cancel

Every abort goes through `cancel(handle, reason)`, which records the reason on the run's handle before it aborts, and the first reason wins. A `latest-wins` supersede records `'superseded'`, `reset()` records `'reset'`, and `dispose()` records `'dispose'`. The run's `'cancel'` event carries it as `reason`. `dropSerialQueue` rejects the queued `serial` runs for `reset()` and `dispose()`, and reports a `'cancel'` with the same reason for each, because each one reported `'queued'` (spec §13.1).

The reason exists for `@kontsedal/olas-mutation-queue`. A supersede and a reset are the app dropping the run, so the queue drops its entry. A dispose only means the screen is gone, so the queue keeps it for a replay. Before the reason existed the queue kept every cancelled entry, and an autosave's superseded draft replayed after the draft that replaced it. Pinned by `mutation-plugin-events.test.ts`.

Every `'cancel'` goes out through `reportCancel` (`mutation.ts:398-407`), which also sends devtools a `mutation:cancel` with the same `reason`, in dev builds, under the run id as `causeId` (spec §14.1). The three call sites are `dropSerialQueue`, the queued run aborted during its `onMutate`, and the catch block's abort branch. Before 1.0's second review devtools heard nothing on a cancel. The panel then paired the superseding run's settle with the superseded run's start. A queued run that never started sends one too, with no `mutation:run` before it. A run whose work finished before a late abort reports `'success'`, so it sends no cancel. Pinned by `mutation-cancel-devtools.test.ts`, which checks that the two streams agree run by run.

## Dispose

Aborts every inflight handle. Drains the serial queue with `AbortError`. Plugins hear each run as `'cancel'` with reason `'dispose'`. Sets `disposed: true`. Idempotent.

**`run()` afterwards rejects with `MutationDisposedError`**, exported from `@kontsedal/olas-core` and carrying `mutationId` and `controllerPath`. `mutate` is never called, so the write does not happen. It is deliberately **not** an `AbortError`, and that asymmetry is the design. `isAbortError` is how callers filter cancellations, and a run that was never accepted is not one. Until 2026-09-03 it was a bare `Error('Mutation disposed')`, which was neither filterable nor identifiable. A consumer doing the correct thing still surfaced "Failed to drop database: Mutation disposed" to a user, and one doing the blanket thing lost the write in silence.

**`detached: true` (§6.5) turns all of that off.** `dispose()` marks the mutation disposed and returns without aborting. In-flight runs finish, the serial queue drains, `run()` keeps working, and the lifecycle callbacks still fire. That is how the invalidation hanging off `onSuccess` lands instead of being skipped. `reset()` and a `latest-wins` supersede still cancel, because both are the app explicitly dropping a run, where dispose only means the screen is gone. `reset()` deliberately keeps working after dispose, because it is then the only stop button left. Internally the whole distinction is the `cancelledByDispose` getter, defined as `disposed && !detached`. `run()`, `reset()` and the post-await branch consult that instead of `disposed`.

Callbacks on a detached run execute after the controller is torn down, so they must stay at client level (`query.invalidate()`, a toast). If the root is gone the run still completes but its cache writes no-op, since `QueryClient.dispose()` deregisters the client from every query (`client.ts:2248-2269`).

`reset()` is similar but doesn't mark disposed — it aborts inflight, drains the queue, and clears `data`/`error`/`lastVariables`/`isPending` and sets `status` back to `'idle'`. The mutation remains usable. `mutation.ts:765-785`; spec §6.2 lists it among the abort triggers; pinned by `mutation.test.ts:57` and regression B2.

**The abort is a migration hazard.** react-query's `reset()` detaches the observer and lets the in-flight request finish; ours cancels it. Same name, same signature, no type error on a port. The public TSDoc claimed "without aborting in-flight runs" from 612720b until 2026-07-31. That is ten weeks and three releases, long enough for a porting consumer to have taken it at face value. This was reported rather than corroborated here; see `../log.md`. `mutation.ts:255-273` now carries the warning, as do the Mutations section of `../../API.md` and `../../MIGRATING.md`.
