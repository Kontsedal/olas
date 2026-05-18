---
name: mutation-concurrency
description: parallel / latest-wins / serial — the three execution paths inside MutationImpl.
type: flow
covers:
  - packages/core/src/query/mutation.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: uses, target: ../entities/mutation.md }
  - { type: related, target: ../pitfalls/latest-wins-rollback-order.md }
  - { type: related, target: ../pitfalls/raceabort-for-misbehaving-mutate.md }
last_verified: 2026-05-18
confidence: high
---

# Flow: mutation concurrency

What `mutation.run(vars)` does depends on `spec.concurrency`. Spec §6.1.

## Parallel (default)

Every `run()` is independent. `isPending` is true while ANY inflight. `data` reflects the most-recent completion. Use for: distinct operations that don't conflict (save A, delete B, etc.).

```
run(vars):
  return executeRun(vars)
```

## Latest-wins

New `run()` aborts every inflight + rolls back their snapshots **synchronously before invoking the new onMutate**:

```
run(vars):
  for handle of inflight:
    handle.abort.abort()
    handle.snapshot?.rollback()
    handle.snapshot = undefined   # prevent double-rollback in the old run's catch
  return executeRun(vars)
```

Order matters — see `../pitfalls/latest-wins-rollback-order.md`. If you rollback after the new `onMutate` runs, you clobber the new optimistic update.

Superseded runs **do not** populate `error`, do not invoke `onError`, do not invoke `onSettled`. Their returned promise rejects with AbortError. Callers should use `isAbortError(err)` to filter:

```ts
try { await mutation.run(vars) }
catch (e) { if (isAbortError(e)) return; throw e }
```

## Serial

Runs queue. Process one at a time.

```
run(vars):
  return enqueueSerial(vars)

enqueueSerial(vars):
  if active:
    return new Promise((resolve, reject) =>
      serialQueue.push({ vars, resolve, reject }))
  active = true
  return executeRun(vars).finally(() => advanceSerialQueue())
```

`advanceSerialQueue()` shifts the next entry, calls `executeRun`, resolves/rejects the stored promise, recurses. When the queue is empty, `active = false`.

`dispose()` aborts the current inflight AND rejects every queued entry with `AbortError`. `reset()` is similar but doesn't dispose.

## `executeRun` — shared by all modes

See `../entities/mutation.md` for the full implementation walkthrough. The key shape:

```
1. snapshot = onMutate(vars)
2. inflight.add({ abort, snapshot })
3. inflightCounter.update(n => n+1)  # client.mutationsInflight$
4. await raceAbort(runWithRetry(vars, abort.signal), abort.signal)
5. on success: data=result; onSuccess; onSettled
   on supersede (AbortError / signal.aborted): snapshot.rollback(); throw — no callbacks
   on error: error=err; onError(err, vars, snapshot); onSettled(undefined, err, vars)
6. finally: inflight.delete; inflightCounter.update(n => n-1); maybe isPending=false
```

## `raceAbort`

```ts
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    let settled = false
    signal.addEventListener('abort', () => {
      if (settled) return; settled = true
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
    promise.then(v => { if (!settled) { settled = true; resolve(v) } },
                 e => { if (!settled) { settled = true; reject(e) } })
  })
}
```

If the user's `mutate` ignores its `AbortSignal`, the supersede path can still reject the run. Without this, latest-wins (and dispose mid-flight) would leak promise resolution forever. See `../pitfalls/raceabort-for-misbehaving-mutate.md`.

## Tests of note

`packages/core/tests/mutation.test.ts`:
- `multiple runs are independent; isPending tracks any in-flight` — parallel.
- `new run aborts the previous; superseded run rejects with AbortError` — latest-wins.
- `onMutate snapshot is rolled back on supersede` — latest-wins ordering.
- `queued runs execute one at a time in order` — serial.
- `stacked optimistic updates: later mutation rollback lands on earlier intermediate state` — §6.4.
