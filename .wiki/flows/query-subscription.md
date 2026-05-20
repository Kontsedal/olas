---
name: query-subscription
description: ctx.use(query, keyFn) — from call site to reactive AsyncState. The hottest path in the library.
type: flow
covers:
  - packages/core/src/query/use.ts
  - packages/core/src/query/client.ts
  - packages/core/src/controller/instance.ts:295-330
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../entities/query-client.md }
  - { type: uses, target: ../entities/entry.md }
  - { type: related, target: ../pitfalls/callargs-vs-keyargs.md }
last_verified: 2026-05-20
confidence: medium
---

# Flow: query subscription

End-to-end walkthrough of `ctx.use(query, keyFn)` from call site to reactive AsyncState. Spec §5.4–5.6, §21.

## The call site

```ts
const userController = defineController((ctx, props: { id: string }) => {
  const user = ctx.use(userQuery, () => [props.id])
  return { user }
})
```

## Step by step

### 1. Dispatch on brand — `instance.ts:303`

`ctx.use(query, keyOrOptions)`:

```ts
const brand = query.__olas
if (brand === 'infiniteQuery') return createInfiniteUse(...)
return createUse(...)
```

### 2. `createUse(client, query, keyOrOptions)` — `use.ts:83`

Builds a `SubscriptionImpl<T>` and an `effect` that owns the binding:

```ts
const sub = new SubscriptionImpl<T>(keepPreviousData)
let currentEntry: ClientEntry<T> | null = null

const effectDispose = effect(() => {
  if (!enabled()) {                     # enabledFn from options
    untracked(() => { release(currentEntry); sub.detach() })
    return
  }
  const args = keyFn() as Args          # TRACKED — re-runs when these signals change

  untracked(() => {                     # everything that mutates entries is outside the tracking scope
    const entry = client.bindEntry(query, args)
    if (currentEntry === entry) return  # same key, nothing to do
    currentEntry?.release()
    entry.acquire()
    currentEntry = entry
    sub.attach(entry)

    if (!entry.entry.isFetching.peek() &&
        (status === 'idle' || entry.entry.isStaleNow() || status === 'error')) {
      entry.entry.startFetch().catch(() => {})
    }
  })
})
```

Key tricks:

- `keyFn()` runs **inside the tracking scope**. Any signal it reads becomes a dep — the effect re-runs when those signals change. That's how `props.id` flipping causes an entry swap.
- Everything inside `untracked(...)` is shielded — bind/release/acquire are imperative, not reactive deps.
- We refetch on subscribe only if status is `idle` / stale / errored — not if a fetch is already in flight (otherwise concurrent subscribers would double-fetch the same entry).

### 3. `client.bindEntry(query, args)` — `client.ts:746`

Looks up the entry in `client.maps`. If absent:

1. Register `this` with `query.__clients` (so `query.invalidate` reaches us).
2. Compute `keyArgs = spec.key(...args)`.
3. Compute `hash = stableHash(keyArgs)`.
4. Check `hydratedData` for an SSR-restored row; consume if present.
5. `new ClientEntry(this, query, args, keyArgs, spec, hydrated)`.
6. Store under `map[hash]`.

`ClientEntry`'s constructor builds an `Entry<T>` with a fetcher closure that captures the original `args` (the user's call args, not the hash key — these are distinct, see `../pitfalls/callargs-vs-keyargs.md`).

### 4. `entry.acquire()` — `client.ts:254`

Subscriber count goes up. Cancels any pending `gcTimer`. If count just became 1 and there's a `refetchInterval`, starts the interval timer.

### 5. `SubscriptionImpl.attach(entry)` — `use.ts:48`

Sets the subscription's `current$` signal to the new entry. The subscription's `data`/`error`/`status`/... are all computeds over `current$.value?.entry.<sig>.value` — flipping `current$` ripples through every derived signal in one batched update.

For `keepPreviousData: true`, captures the old entry's `data` into `previousData$` before the swap so the consumer keeps seeing the previous value until the new entry has data of its own.

### 6. The fetch resolves

Inside `Entry.startFetch` → `runWithRetry` → success branch:

```ts
batch(() => {
  data.set(result); error.set(undefined); status.set('success')
  isLoading.set(false); isFetching.set(false)
  lastUpdatedAt.set(Date.now())
  isStale.set(staleTime === 0)
})
```

Subscribers downstream see one notification pass.

## On disposal

The `LifecycleEntry` recorded by `ctx.use` (kind `cleanup`, dispose = the `dispose` returned by `createUse`) fires:

```ts
const dispose = () => {
  effectDispose()                # stop tracking keys
  currentEntry?.release()        # subscriber count down; may start gcTimer
  currentEntry = null
  sub.detach()
}
```

Once `subscriberCount` hits zero on the entry, the gc timer is scheduled. If no new subscriber arrives in `gcTime` ms, `dropEntry` removes the entry from the client's map and disposes its underlying `Entry`.
