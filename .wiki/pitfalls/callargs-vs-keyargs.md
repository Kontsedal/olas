---
name: callargs-vs-keyargs
description: Two arg arrays inside ClientEntry. One goes to the fetcher; one goes to the hash. They are not the same.
type: pitfall
covers:
  - packages/core/src/query/client.ts:31-222
  - packages/core/src/query/client.ts:881-960
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../entities/query-client.md }
last_verified: 2026-05-22
confidence: high
---

# `callArgs` vs `keyArgs`

## The trap

A `Query` has both:

```ts
defineQuery({
  key:     (id: string) => ['user', id],                                // produces the HASH key
  fetcher: ({ signal }, id: string) => api.getUser(id, { signal }),     // receives the ORIGINAL `id`,
                                                                        // not `['user', id]`
})
```

Inside `ClientEntry` we store two different arrays:

- **`callArgs`** — what `ctx.use(query, () => ['u1'])` passed: `['u1']`. This is what the fetcher needs.
- **`keyArgs`** — what `spec.key('u1')` returned: `['user', 'u1']`. This is what we hash for identity.

If you pass `keyArgs` to the fetcher, you'll call `getUser('user', { signal })` — wrong `id`, broken request.

## The bug we hit

Original Phase 5 implementation only kept `keyArgs` on the entry:

```ts
// BAD — collapsed both into "args"
this.entry = new Entry<T>({
  fetcher: () => (signal) => fetcherFn({ signal, deps }, ...args),  // args = keyArgs here
})
```

Test `defineQuery + ctx.use > subscribing fetches; data lands on success` failed because the fetcher received `['user', 'u1']` instead of `['u1']`.

Fix: separate both args arrays explicitly on `ClientEntry` (`client.ts:31-89`):

```ts
constructor(
  client, query,
  callArgs: readonly unknown[],          // for the fetcher
  keyArgs:  readonly unknown[],          // for the hash
  spec,
  hydrated?,
) {
  ...
  this.callArgs = callArgs
  this.keyArgs  = keyArgs
  this.entry = new Entry<T>({
    fetcher: () => (signal) =>
      fetcherFn({ signal, deps }, ...(callArgs as never[])),  // NOTE: callArgs, not keyArgs
    initialData: hydrated?.data,
    initialUpdatedAt: hydrated?.lastUpdatedAt,
  })
}
```

`dropEntry`, `invalidate`, `invalidateAll`, and `bindEntry`'s hash-collision dedupe path (`client.ts:881-960`) all hash with `stableHash(...)` over `keyArgs`.

## Why have both?

`spec.key` exists so consumers can:

- Add discriminators (`'user'` prefix to avoid colliding with `['post', id]`).
- Normalize args (e.g. lowercasing an email before hashing).
- Drop irrelevant args (`{ pageSize: 10, sort: 'newest' }` → just `[sort]` if pageSize is fixed).

If `key` always returned the args unchanged, we'd merge them. But it doesn't — and that's the point.

## How to spot this when reviewing changes

Search for any place that calls `spec.fetcher`. The call should always use `callArgs`, never `keyArgs`. The reverse is also true for `stableHash` — it always operates on `keyArgs`.
