---
name: raceabort-for-misbehaving-mutate
description: Wrap the mutate fn's promise in a raceAbort against the abort signal. Otherwise misbehaving mutates can hang forever.
type: pitfall
covers:
  - packages/core/src/query/mutation.ts:184-247
  - packages/core/src/query/mutation.ts:347-374
edges:
  - { type: tested-by, target: ../../packages/core/tests/mutation.test.ts }
  - { type: uses, target: ../entities/mutation.md }
last_verified: 2026-05-21
confidence: high
---

# Race the mutate promise against its abort signal

## The trap

`AbortSignal` is cooperative — the holder of the signal must check / honor it. If a user's `mutate` function ignores its signal:

```ts
ctx.mutation({
  mutate: async (vars) => {
    return externalLibrary.doStuff(vars)   # does not pass the AbortSignal through
  },
  concurrency: 'latest-wins',
})
```

then aborting the signal does nothing — the awaited promise still runs to completion. For `latest-wins`, every superseded run would resolve eventually (with its outdated result), and the calling code would have to filter. For `dispose`, the run would outlive the controller.

## The bug we hit

Phase 6 test `onError/onSettled are NOT invoked on supersede` timed out at 5000ms. The mutate didn't pass signal through:

```ts
mutate: async () => {
  const d = ds[i++]!
  return d.promise               # signal ignored
},
```

The first run was aborted when the second arrived, but the first run's `await mutate(...)` was still waiting for `ds[0]` (which we never resolved). The `executeRun` function never returned, the `inflight` set never drained, `isPending` never flipped back. Eventually vitest killed the test.

## The fix

Wrap the awaited promise in `raceAbort`:

```ts
try {
  const result = await raceAbort(this.runWithRetry(vars, abort.signal), abort.signal)
  if (abort.signal.aborted || this.disposed) {
    snapshot?.rollback()
    throw new DOMException('Superseded', 'AbortError')
  }
  ...
}
```

```ts
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); resolve(v) } },
      (e) => { if (!settled) { settled = true; signal.removeEventListener('abort', onAbort); reject(e) } },
    )
  })
}
```

Now even if `mutate` doesn't respect the signal, the outer promise rejects with AbortError when superseded. The `finally` block runs, `inflight` drains, `isPending` flips.

## Why we still pass the signal to mutate

Well-behaved mutates DO use the signal — they cancel I/O early. That's a free perf win. `raceAbort` is the safety net for the cooperative-protocol failure mode, not the primary mechanism.

## Where it's used

- `MutationImpl.executeRun` — the main consumer.
- Not currently used in `Entry.startFetch` (fetchers are expected to be more careful — and aborting in-flight cache fetches via signal is the only sane behavior). If a similar bug surfaces for fetchers we can add it there too.
