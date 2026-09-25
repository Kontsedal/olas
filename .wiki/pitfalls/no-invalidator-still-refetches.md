---
name: no-invalidator-still-refetches
description: "\"Nothing invalidates this query\" does not mean \"no fetch is in flight\" — a stale entry refetches on acquire/resume, so an optimistic setData still needs cancel() first."
type: pitfall
covers:
  - packages/core/src/query/use.ts
  - packages/core/src/query/client.ts:1182-1276
  - packages/core/src/query/types.ts:315-400
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: related, target: ../modules/eslint-plugin.md }
last_verified: 2026-09-25
confidence: high
---

# "No invalidator" does not mean "no fetch in flight"

## The trap

The optimistic-write recipe (spec §6.4) says: `cancel()` the query, *then* `setData()`. The stated reason is that an in-flight fetch resolving after the patch overwrites it.

That reason invites an optimisation which is **wrong**:

```ts
// "This query has exactly one reader and nothing anywhere calls
//  uiState.invalidate(). So no fetch can be outstanding. Skip the cancel."
const uiState = bindQuery(ctx, uiStateQuery)
onMutate: (vars) => uiState.setData((prev) => patch(prev, vars)),
```

An entry does not need an invalidator to fetch. It fetches whenever a **subscription acquires it while stale** — and `staleTime` makes "stale" a function of the clock, not of anything a grep can find:

- A first subscriber binding the entry (`bindEntry` → `isStaleNow()` → `startFetch`).
- A second root binding the same key.
- **`resume()` after a suspend** (spec §4.1) — the case that shipped downstream: a feature suspended while hidden, resumed when shown, and re-acquired a subscription whose entry had gone stale in between.

The fetch starts at the moment of that acquire, so a write racing it loses. Nothing in the program says `invalidate`.

## What it looks like when it bites

An optimistic toggle that visibly reverts a moment later, only if the user had hidden and re-shown the feature at least `staleTime` ago. Transient, self-healing, unreproducible on the first try — which is exactly why it survived code review and was only caught by mutation-testing the `cancel()` line back in.

## The rule

Call `cancel(...)` before an optimistic `setData(...)` **unconditionally**. It is synchronous, so it fits a sync `onMutate`. It is a no-op when nothing is in flight. It costs one line against a class of bug whose defining property is that it does not reproduce.

```ts
const uiState = bindQuery(ctx, uiStateQuery)  // root-scoped; see §21.5

onMutate: (vars) => {
  const prev = uiState.peek()             // guard: nothing cached ⇒ nothing to patch
  if (prev === undefined) return undefined
  uiState.cancel()                        // ALWAYS, invalidator or not
  return uiState.setData((p) => patch(p, vars))
},
```

## The adjacent trap: `replace` supersedes, `write` does not

The same reasoning error has a sibling: assuming a *canonical* write is safe from this race. A consumer app paid for it twice in a day: a result grid blanked a moment after its query finished, and a tab, split or panel-close undid itself.

**`replace(...)` supersedes the in-flight fetch itself** (spec §6.4; pinned in `query.test.ts:1108`, "replace supersedes an in-flight fetch when the entry already holds data"). A whole value from the server is newer than any request issued before it. **`write(...)` does not.** It patches, and a patch has no claim on the fields it left alone, so a response that lands after it overwrites it. 0.7.2 moved the supersede from `write` to `replace` for that reason. A `write` that must survive an in-flight fetch still needs `cancel()` first, as `setData` does.

| | is it newer than an outstanding request? | so |
|---|---|---|
| `replace` | **yes** — the whole value, from the server | supersedes it itself |
| `write` | only for the fields it touched | a response may overwrite it; cancel first when that matters |
| `setData` | no — it is a guess | a response may overrule it; cancel first |

**The one thing `replace` will not do is cancel when the new value is `undefined`** (`packages/core/src/query/client.ts:1640-1656`). A write flips an idle or pending entry to `status: 'success'` whatever it is handed. Replacing with `undefined` and cancelling as well would strand the entry at `success` over no data, with nothing to refetch it until `staleTime` lapses. So that fetch is left to produce the first value.

## Where it's documented

`SPEC.md` §5.5 ("*'Nothing invalidates this query' does not mean 'no fetch is in flight'*") and §6.4, plus the TSDoc on `Query.setData` and `Query.cancel` (`query/types.ts`). All three were written *after* the downstream regression — before that, the spec mentioned only the invalidation-driven case, which is what made the false optimisation reachable.

## What catches it now

`olas/cancel-before-optimistic` in `@kontsedal/olas-eslint-plugin` reports an `onMutate` whose `setData` has no `cancel` on the same query before it (`modules/eslint-plugin.md`). Its first run over the example apps found three such sites in kanban's board controller, all fixed. The regression test "a board fetch in flight when a move starts cannot land over the move" in `examples/kanban/tests/board.test.ts` shows what the missing cancel did: a refetch that read the server before the move reached it landed over the move.
