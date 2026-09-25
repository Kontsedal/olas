---
name: suspend-on-undefined-data
description: Suspending while data === undefined loops forever when a load settles on undefined, because the promise React waits on resolves at once; suspend only until the first load settles.
type: pitfall
covers:
  - packages/react/src/hooks.ts:302-332
edges:
  - { type: tested-by, target: ../../packages/react/tests/suspense.test.tsx }
  - { type: related, target: ../decisions/disabled-subscriptions.md }
  - { type: uses, target: ../modules/react.md }
last_verified: 2026-09-25
confidence: medium
---

# Suspending on `data === undefined` loops

## The trap

A Suspense hook throws a promise while it has nothing to show, and React renders again when the promise settles. "Nothing to show" was written as `data === undefined`. A load can succeed with `undefined`:
- a `select` that reads an optional field, `select: (u) => u.nickname`;
- a fetcher that resolves nothing;
- an infinite query replaced with no pages, whose `data` is `undefined`.

The subscription is at `'success'` then, so `firstValue()` resolves at once. React retries, the hook sees `undefined` again, and throws the same resolved promise. The review counted 2,001 renders before it stopped the loop, and the loop starved the event loop meanwhile.

## The fix

`suspendUntilData` (`packages/react/src/hooks.ts:315-332`) suspends only while nothing has settled. A subscription has settled when its `status` is `'success'`, when it holds data, or when it has a `lastUpdatedAt` from an earlier load. So:
- a success with `undefined` renders `undefined`;
- a background refetch over an `undefined` result reads `status: 'pending'` with no data, and its `lastUpdatedAt` keeps it from suspending;
- a failed refetch after any success keeps the last value on screen, as it always did for defined data;
- a first load that fails still throws its error to the ErrorBoundary, and a disabled query still suspends until it is enabled and loads (`../decisions/disabled-subscriptions.md`).

The tracked keys for Suspense stay `data` and `status`. The decision cannot move without one of them moving: a new key with no data flips `status` too.

Vue and Svelte have no Suspense hook, so neither adapter has the loop.

## The general rule

Wait on the state that the promise resolves on, not on a value that state happens to imply. `firstValue()` resolves when the load settles, so the hook must suspend on "not settled", or the promise and the check disagree.

Pinned by `suspense.test.tsx`, "suspense on a subscription that settled on undefined". It covers a `select` over a missing field, a fetcher that resolves `undefined` and then refetches, and `replace([])` on an infinite query. Each test has a render cap that turns the loop into a failure instead of a hang.
