---
name: no-invalidator-still-refetches
description: "\"Nothing invalidates this query\" does not mean \"no fetch is in flight\" — a stale entry refetches on acquire/resume, so an optimistic setData still needs cancel() first."
type: pitfall
covers:
  - packages/core/src/query/use.ts
  - packages/core/src/query/client.ts:1108-1200
  - packages/core/src/query/types.ts:297-380
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-08-12
confidence: high
---

# "No invalidator" does not mean "no fetch in flight"

## The trap

The optimistic-write recipe (spec §6.4) says: `cancel()` the query, *then* `setData()`. The stated reason is that an in-flight fetch resolving after the patch overwrites it.

That reason invites an optimisation which is **wrong**:

```ts
// "This query has exactly one reader and nothing anywhere calls
//  uiStateQuery.invalidate(). So no fetch can be outstanding. Skip the cancel."
onMutate: (vars) => uiStateQuery.setData((prev) => patch(prev, vars)),
```

An entry does not need an invalidator to fetch. It fetches whenever a **subscription acquires it while stale** — and `staleTime` makes "stale" a function of the clock, not of anything a grep can find:

- A first subscriber binding the entry (`bindEntry` → `isStaleNow()` → `startFetch`).
- A second root binding the same key.
- **`resume()` after a suspend** (spec §4.1) — the case that actually shipped downstream: a feature suspended while hidden, resumed when shown, and re-acquired a subscription whose entry had gone stale in between.

The fetch starts at the moment of that acquire, so a write racing it loses. Nothing in the program says `invalidate`.

## What it looks like when it bites

An optimistic toggle that visibly reverts a moment later, only if the user had hidden and re-shown the feature at least `staleTime` ago. Transient, self-healing, unreproducible on the first try — which is exactly why it survived code review and was only caught by mutation-testing the `cancel()` line back in.

## The rule

Call `cancel(...)` before an optimistic `setData(...)` **unconditionally**. It is synchronous, so it fits a sync `onMutate`; it is a no-op when nothing is in flight; and it costs one line against a class of bug whose defining property is that it doesn't reproduce.

```ts
onMutate: (vars) => {
  const prev = uiStateQuery.peek()          // guard: nothing cached ⇒ nothing to patch
  if (prev === undefined) return undefined
  uiStateQuery.cancel()                     // ALWAYS, invalidator or not
  return uiStateQuery.setData((p) => patch(p, vars))
},
```

## The adjacent trap

The same reasoning error has a sibling: assuming a *canonical* write is safe from the same race. It isn't — `query.write(...)` has no snapshot to lose, but a fetch landing after it still overwrites the value (pinned in `query.test.ts`, "a write lands over an in-flight fetch only until that fetch resolves"). Cancel first there too when the write must win.

## Where it's documented

`SPEC.md` §5.5 ("*'Nothing invalidates this query' does not mean 'no fetch is in flight'*") and §6.4, plus the TSDoc on `Query.setData` / `Query.cancel` (`query/types.ts`). All three were written *after* the downstream regression — before that, the spec mentioned only the invalidation-driven case, which is what made the false optimisation reachable.
