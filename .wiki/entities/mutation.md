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
last_verified: 2026-05-18
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
  lastVariables: ReadSignal<V | undefined>
  reset(): void
  dispose(): void
}
```

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
4. isPending = true; lastVariables = vars
5. try:
   result = await raceAbort(runWithRetry(vars, abort.signal), abort.signal)
   if aborted/disposed: snapshot?.rollback(); throw AbortError
   data = result; error = undefined
   onSuccess(result, vars)
   onSettled(result, undefined, vars)
   return result
6. catch err:
   if AbortError or signal.aborted: snapshot?.rollback(); throw   # supersede — no error/onError/onSettled
   error = err
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

## Retry

`runWithRetry` follows the same shape as `Entry.runWithRetry`: catch err → check `shouldRetry(retry, attempt, err)` → `await abortableSleep(...)` → retry. The user-facing promise resolves with the final outcome.

## Dispose

Aborts every inflight handle. Drains the serial queue with `AbortError`. Sets `disposed: true`. Idempotent.

`reset()` is similar but doesn't mark disposed — it aborts inflight, drains the queue, and clears `data`/`error`/`lastVariables`/`isPending`. The mutation remains usable.
