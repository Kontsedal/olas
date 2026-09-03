---
name: mutation
description: MutationImpl — three concurrency modes, optimistic + positional rollback, abort-race.
type: entity
covers:
  - packages/core/src/query/mutation.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: uses, target: entry.md }
  - { type: uses, target: ../flows/mutation-concurrency.md }
  - { type: related, target: ../pitfalls/latest-wins-rollback-order.md }
  - { type: related, target: ../pitfalls/raceabort-for-misbehaving-mutate.md }
last_verified: 2026-09-03
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

`status` (T4.2) is the outcome of the latest run — the thing React's `useMutation` derives `isIdle`/`isSuccess`/`isError` from, so a `void` mutation (which resolves `undefined`) still reports `'success'` rather than looking stuck at `'idle'` (the old React heuristic read `data !== undefined`). Distinct from `isPending` (true while *any* run is in flight, parallel mode). A superseded `latest-wins` run does NOT flip `status` to `'error'` — the superseder owns it.

## Concurrency modes

| mode | semantics |
|------|-----------|
| `parallel` *(default)* | every `run()` is independent; `isPending` true if any inflight; `data`/`error` reflect the most-recent completion |
| `latest-wins` | new `run()` aborts every inflight AND **synchronously rolls back their snapshots BEFORE invoking the new `onMutate`** (see `../pitfalls/latest-wins-rollback-order.md`) |
| `serial` | queue; one at a time in order; `dispose` rejects queued runs with AbortError |

## `executeRun(vars)` — the core path

```
1. onMutate(vars) → snapshot
2. handle = { abort, snapshot }; inflight.add(handle)
3. inflightCounter.update(n => n+1)   # routes to client.mutationsInflight$
4. isPending = true; status = 'pending'; lastVariables = vars
5. try:
   result = await raceAbort(runWithRetry(vars, abort.signal), abort.signal)
   if aborted/disposed: snapshot?.finalize(); settle 'success'; throw AbortError
   data = result; error = undefined; status = 'success'
   onSuccess(result, vars)
   onSettled(result, undefined, vars)
   return result
6. catch err:
   if AbortError or signal.aborted: snapshot?.rollback(); throw   # supersede — no error/status/onError/onSettled
   error = err; status = 'error'
   onError(err, vars, snapshot)
   onSettled(undefined, err, vars)
   throw
7. finally:
   inflight.delete(handle)
   inflightCounter.update(n => n-1)
   if inflight.size === 0: isPending = false
```

Notes:
- **`raceAbort(promise, signal)`** — if the user's `mutate` ignores its `AbortSignal`, the wrapper still rejects with AbortError when superseded. Without this, misbehaving fetchers could leave runs hanging forever. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.
- **Supersede ≠ failure.** AbortError doesn't populate `mutation.error`, doesn't invoke `onError`, doesn't invoke `onSettled`. Spec §6.1 is explicit.
- **`onMutate` runs synchronously in `run()`** before the await. Snapshots are recorded before any I/O.
- **A run that COMPLETED is never rolled back** (2026-09-03). Reaching the post-await branch means `raceAbort` *resolved* — the work finished and the abort landed in the gap before the continuation. You cannot cancel what already happened, so the branch finalizes instead of rolling back (a rollback would commit a knowingly stale value to a cache that outlives the mutation, and the `onSuccess` that normally invalidates is skipped on this path), and a persistable run settles `'success'` rather than `'cancelled'` — `'cancelled'` tells `@kontsedal/olas-mutation-queue` to KEEP the durable entry and replay it next load, i.e. a second write of a request the server accepted. The promise still rejects with `AbortError`. A `latest-wins` supersede consumed its snapshot back in `run()`, so the finalize is a no-op there. Pinned in `mutation.test.ts` ("a run that COMPLETED before dispose finalizes its snapshot") and `mutation-queue/tests/plugin.test.ts`.
- **Snapshots are wrapped single-consume.** `wrapSnapshot` makes `rollback()` / `finalize()` idempotent across each other — whichever fires first wins. On success the path auto-calls `snapshot.finalize()` (clears `hasPendingMutations`); on error it auto-calls `snapshot.rollback()` after the user's `onError` (no-op if `onError` already called `rollback`). Spec §6.4.

## Retry

`runWithRetry` follows the same shape as `Entry.runWithRetry`: catch err → check `shouldRetry(retry, attempt, err)` → `await abortableSleep(...)` → retry. The user-facing promise resolves with the final outcome.

## Dispose

Aborts every inflight handle. Drains the serial queue with `AbortError`. Sets `disposed: true`. Idempotent.

**`run()` afterwards rejects with `MutationDisposedError`** (exported from `@kontsedal/olas-core`; carries `mutationName` + `controllerPath`) and `mutate` is never called — the write does not happen. It is deliberately **not** an `AbortError`, and that asymmetry is the design: `isAbortError` is how callers filter cancellations, and a run that was never accepted is not one. Until 2026-09-03 it was a bare `Error('Mutation disposed')`, which was neither filterable nor identifiable — a consumer doing the correct thing still surfaced "Failed to drop database: Mutation disposed" to a user, and one doing the blanket thing lost the write in silence.

**`detached: true` (§6.5) turns all of that off.** `dispose()` marks the mutation disposed and returns without aborting: inflight runs finish, the serial queue drains, `run()` keeps working, and the lifecycle callbacks still fire — which is how the invalidation hanging off `onSuccess` lands instead of being skipped. `reset()` and a `latest-wins` supersede still cancel (both are the app explicitly dropping a run; dispose only means the screen is gone), and `reset()` deliberately keeps working post-dispose because it is then the only stop button left. Internally the whole distinction is the `cancelledByDispose` getter — `disposed && !detached` — which is what `run()`, `reset()` and the post-await branch consult instead of `disposed`.

Callbacks on a detached run execute after the controller is torn down, so they must stay at client level (`query.invalidate()`, a toast). If the root is gone the run still completes but its cache writes no-op, since `QueryClient.dispose()` deregisters the client from every query (`client.ts:1054-1061`).

`reset()` is similar but doesn't mark disposed — it aborts inflight, drains the queue, and clears `data`/`error`/`lastVariables`/`isPending` and sets `status` back to `'idle'`. The mutation remains usable. `mutation.ts:607-629`; spec §6.2 lists it among the abort triggers; pinned by `mutation.test.ts:54` and regression B2.

**The abort is a migration hazard.** react-query's `reset()` detaches the observer and lets the in-flight request finish; ours cancels it. Same name, same signature, no type error on a port. The public TSDoc claimed "without aborting in-flight runs" from 612720b until 2026-07-31 — ten weeks and three releases, long enough for a porting consumer to have taken it at face value (reported, not corroborated here — see `../log.md`). `mutation.ts:226-244` now carries the warning, as do `../../API.md` (Mutations) and `../../MIGRATING.md`.
