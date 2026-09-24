---
name: disabled-subscriptions
description: What a subscription does while its `enabled` is false — the `isEnabled` signal, `QueryDisabledError` from refetch, and a firstValue that waits (which makes suspense on a dependent query work).
type: decision
covers:
  - packages/core/src/query/use.ts
  - packages/core/src/query/errors.ts
  - packages/core/src/query/types.ts:20-75
  - packages/react/src/hooks.ts
edges:
  - { type: tested-by, target: ../../packages/core/tests/use-edges.test.ts }
  - { type: tested-by, target: ../../packages/react/tests/suspense.test.tsx }
  - { type: uses, target: ../modules/query.md }
  - { type: related, target: ../modules/react.md }
last_verified: 2026-09-25
confidence: medium
---

# A disabled subscription says so

A subscription whose `enabled` returns `false` holds no entry (spec §5.7). Its key may not even be computable yet: `enabled` usually guards the key. Before 1.0 that state was invisible, and two of its consequences were open BACKLOG items.

## The decision

- **`AsyncState.isEnabled`** is a `ReadSignal<boolean>`, `false` while `enabled` returns `false`. The subscription effect sets it before it detaches or binds (`packages/core/src/query/use.ts`). It is always `true` for a `LocalCache`, which has no `enabled` switch. `useQuery` returns it too.
- **`refetch()` on a disabled subscription rejects with `QueryDisabledError`** (`packages/core/src/query/errors.ts`), carrying `queryId`. Before, the rejection was an anonymous `Error('[olas] no active subscription')`. A "Retry" button wired to `refetch()` needed a blanket `.catch(() => {})` wherever `enabled` could be false. Now it can filter the named error, or disable itself on `isEnabled`. A disposed subscription rejects with an `AbortError` instead.
- **`firstValue()` on a disabled subscription waits** for the next attach and then for that entry's first value. It rejects only when the subscription is disposed. While pending, it hands back the same promise (`FirstValueCache`), so a suspended render that asks again re-throws the promise React already holds.

## Why `firstValue` waits instead of rejecting

The old rejection made `useQuery(sub, { suspense: true })` on a disabled query throw an already-rejected promise. React re-rendered, the hook threw another, and the fallback never resolved. The BACKLOG item recorded that T4.7 tried a hard error for the disabled case. It fired during teardown, because an idle, disabled subscription could not be told from one torn down by `root.dispose()`: both were detached and idle.

Waiting is what a dependent query wants. B is enabled once A's data arrives, so B's suspense view suspends until B is enabled and loaded, instead of never. `isEnabled` now separates the two idle states, and dispose rejects the waiters with an `AbortError`.

A query that is never enabled keeps the fallback up. `useQuery` warns once per subscription in development when it suspends on a disabled query (`warnSuspendedWhileDisabled`, `packages/react/src/hooks.ts`). It warns rather than throws, so a query that is about to be enabled is not an error.

## Alternatives rejected

- **Resolve `refetch()` with `undefined` when disabled.** That widens `refetch: () => Promise<T>` to `Promise<T | undefined>` for every caller, to serve the rare caller that refetches a disabled query.
- **A `status: 'disabled'`.** That adds a fifth status every `switch` on `AsyncStatus` must handle. A disabled subscription's status is honestly `'idle'`: nothing is fetching and nothing has failed.
