---
name: ssr
description: Server-side dehydrate / client-side hydrate, plus waitForIdle.
type: flow
covers:
  - packages/core/src/query/client.ts
  - packages/core/src/controller/root.ts
  - packages/core/src/query/entry.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: uses, target: ../entities/query-client.md }
last_verified: 2026-05-21
confidence: high
---

# Flow: SSR

Spec §15.

## The pattern

```ts
// server
const root = createRoot(rootController, { deps: serverDeps })
await root.waitForIdle()
const state = root.dehydrate()
// — embed state in HTML or send as JSON —

// client
const root = createRoot(rootController, {
  deps: clientDeps,
  hydrate: state,
})
// — subscriptions in the controller tree see the data immediately —
```

Controller state isn't serialized; only the query cache. Controllers reconstruct from props on the client (re-running their factory, re-subscribing). The hydrated cache means subscriptions find data already present and don't re-fetch (subject to `staleTime`).

## What `dehydrate()` emits

```ts
{
  version: 1,
  entries: [
    { key: keyArgs, data, lastUpdatedAt },
    ...
  ]
}
```

Only entries with `status: 'success'` are included. Errors and pending fetches are not serialized — they'd be useless on the client. Infinite queries are skipped today (Phase 12 baseline); supporting them is straightforward but wasn't part of the v1 minimum.

`keyArgs` is `spec.key(...callArgs)` — what `stableHash` runs over. Identity on the client matches identity on the server because the same `defineQuery` runs in both environments and produces the same key tuples.

## What `hydrate(state)` does

`QueryClient.hydrate` populates `hydratedData: Map<keyHash, { data, lastUpdatedAt }>`. **No entries are created at hydrate time.** The hydrated row is consumed lazily on the first `bindEntry` for a matching hash. The new `Entry` is constructed with `initialData` + `initialUpdatedAt` set, which puts it in `status: 'success'` from the start.

Each row is consumed once. If a controller is disposed and re-bound later, the hydrated row is already gone — the second bind refetches normally. This is intentional: hydrate is a "warm start," not a permanent cache.

## staleTime interaction

A hydrated entry's `lastUpdatedAt` is set from the dehydrated payload. On subscribe, `isStaleNow()` checks `Date.now() - lastUpdatedAt >= staleTime`. If the hydrated entry is fresh, subscribe doesn't refetch. If stale, it refetches in the background (status stays `success`, isFetching flips true).

The SSR test `hydrated entries respect staleTime: 0 (refetch on subscribe)` pins this — by default `staleTime: 0` means hydrated data is immediately stale, so the client always refetches once. Use `staleTime: 60_000` etc. to skip the refetch.

## `waitForIdle()`

Used on the server to know when it's safe to dehydrate.

```ts
async waitForIdle(): Promise<void> {
  for (let safety = 0; safety < 100; safety++) {
    const tasks: Promise<void>[] = []
    for entry in maps:        if entry.isFetching.peek(): tasks.push(waitUntilFalse(...))
    for entry in infiniteMaps: if entry.isFetching.peek(): tasks.push(waitUntilFalse(...))
    if mutationsInflight$.peek() > 0:
      tasks.push(wait for mutationsInflight$ to become 0)
    if tasks.length === 0: return
    await Promise.all(tasks)
  }
}
```

The outer loop re-checks because new fetches might start while we were waiting (e.g. a subscribed query's `refetchInterval` fires, or one fetch's success triggers an effect that kicks off another). 100 iterations is a guard against pathological setups.

`mutationsInflight$` is a `Signal<number>` on the QueryClient. `MutationImpl` increments on `executeRun` start, decrements in `finally`.
