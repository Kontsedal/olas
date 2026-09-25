---
name: canonical-vs-optimistic-writes
description: Why the Query handle has separate write methods — setData (optimistic, returns a Snapshot), write (canonical patch) and replace (canonical whole record) — instead of one with an options bag.
type: decision
covers:
  - packages/core/src/query/types.ts:359-495
  - packages/core/src/query/client.ts:1164-1213
  - packages/core/src/query/client.ts:1758-1947
  - packages/core/src/query/client.ts:2082-2179
  - packages/core/src/query/actions.ts:42-59
  - packages/core/src/query/local.ts
  - packages/core/src/query/entry.ts:817-1122
  - packages/core/src/query/infinite.ts:105-137
  - packages/core/src/query/infinite.ts:873-1163
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/catch-up-refetch.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/local-cache-writes.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-rebase.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/optimistic-staleness.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/optimistic-layers.test.ts }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: ../flows/plugin-lifecycle.md }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
  - { type: related, target: ../pitfalls/visible-data-is-not-a-baseline.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-25
confidence: high
---

# Two write methods, not one

`Query` exposes both (`packages/core/src/query/types.ts:366-433`):

```ts nocheck
setData(...keyArgs, updater): Snapshot   // optimistic
write(...keyArgs, updater): void         // canonical
```

A third, `replace(...keyArgs, value)`, came later; see "Three write methods" below.

The core difference is whether a snapshot record is pushed (`Entry.setData`'s `{ track }`, `packages/core/src/query/entry.ts:924-966`), and that difference is load-bearing. A second follows from it. A canonical write rebases live optimistic snapshots, so a mutation that rolls back later restores the canonical data rather than an older baseline. A `write` re-runs its patch on each live baseline, and a `replace` value becomes each one (`entry.ts:937-941`). Until the 1.0 fourth pass every baseline took the value on screen, and a rollback kept the guess that value held; `../pitfalls/visible-data-is-not-a-baseline.md` has the case.

## Why `setData` alone was not enough

A snapshot exists to be **settled** by the mutation that created it. `onMutate` returns it, and the runtime finalizes on success and rolls back on error; see `mutation.ts`. That contract has no counterpart for a write with no mutation behind it: folding a server push into the cache, applying a realtime event, or syncing a value another view just changed.

With only `setData`, such a caller had three options, all bad:

1. Discard the `Snapshot`. Then the record stays **live** forever: `hasPendingMutations` wedged at `true` for the rest of the entry's life, plus one retained baseline per call. On a long-lived entry patched on every server event that array grows without bound — a real leak, not a cosmetic flag.
2. Call `snapshot.finalize()` at every call site. Correct, invisible in review when forgotten, and a strange thing to require of a write that was never optimistic.
3. Reach for the plugin API's canonical write, which already existed: `QueryClientPluginApi.setEntryData` then, `host.queries.write` in 1.0 (`packages/core/src/query/client.ts:1164-1213`). It is **plugin-facing**, addressed by query id and key rather than by the typed handle, and not part of the application surface.

Downstream evidence: one app accumulated eight such sites, being server-push folds and execute-result patches, before the leak was noticed. It filed the issue as "mint a `writeTab` helper with `{ track: false }`", independently re-deriving this method as userland glue it could not implement, because `track` was internal.

## Why not `setData(..., { track: false })`

The handle's signature is variadic, `setData(...args: [...Args, updater])`, so a trailing options bag is not cleanly expressible. With `Args` ending in an object type, TypeScript cannot tell the options from a key argument, and the runtime already recovers the updater positionally at `packages/core/src/query/actions.ts:43` with `rest[rest.length - 1]`. A second named method costs one line of surface and stays unambiguous at both the type level and the call site.

It also reads better where it matters. `write` says *this is true* and `setData` says *this might have to be undone* — the distinction a reader needs, at the call site, without knowing what `track: false` means.

## Three write methods, and why the third one takes a value

The split started as one distinction — snapshot or no snapshot — and grew a second on 2026-08-19:
which writes may supersede a fetch that is already in flight.

| | claim it makes | supersedes an outstanding fetch? |
|---|---|---|
| `setData(...updater)` | a guess a mutation may have to undo | no — a server response may overrule a guess |
| `write(...updater)` | canonical, but only about the fields it touched | no — it has no claim on the rest |
| `replace(...value)` | canonical AND complete: *this is the record now* | **yes** — an earlier request has nothing to add |

**The signature is the contract.** `replace` takes a value rather than an updater, and that is not
sugar: an updater reading `prev` can only ever describe a patch, and the distinction cannot be
recovered inside the entry because the updater's OUTPUT looks identical either way. Asking the
caller to pass the whole value is asking them to make the claim explicitly, and it is the only place
the claim can be made.

This is also where olas leaves react-query behaviour deliberately. react-query has one door,
`setQueryData`, for all three meanings, so it cannot treat them differently; its answer is
`cancelQueries` at every call site (measured against `@tanstack/query-core` 5.101, which clobbers
exactly as olas did before any of this). Three doors can each carry their own rule.

**It cost two published versions to find the middle row.** 0.7.0 and 0.7.1 made `write` itself
supersede, on the reasoning that a canonical write is newer by definition. True of a whole record;
false of a patch. A downstream app folded a one-field push into a cached record while a refetch was
outstanding, the refetch was discarded, and the field it would have brought never arrived — twice,
in two unrelated suites, intermittently, because it is a race. Both releases were rolled back.

The guard moved three times before landing in the signature: "did the entry hold canonical data"
(0.7.0), then "does it hold data after the write" (0.7.1), then — the only one that answers the real
question — "is this write the whole record", which nothing inside the entry can know.

## Why `write` still creates a missing entry

`host.queries.write`, the plugin path, drops silently when `entryByKey` finds no entry (`client.ts:1178-1179`); `write` binds one, exactly as `setData` does. The reason is symmetry: `write` is `setData` minus the snapshot, and diverging on entry creation would make it a second, subtly different write. Callers that must not patch an absent key have `peek(...)` as the guard — and a merge over `undefined` is usually the shape that needs it.

## Infinite queries have the same three doors

`InfiniteQuery` gained `peek`, `write` and `replace` in 1.0 (`packages/core/src/query/infinite.ts:105-137`, `client.ts:2082-2129`). The rules carry over unchanged: `write` patches the pages and leaves an in-flight fetch alone, and `replace` takes whole pages and supersedes it. An empty pages array is how an infinite entry says "nothing here", so a `replace` with `[]` leaves the fetch alone, as `replace(undefined)` does on a regular query. `peek` returns `undefined` for a missing entry or no loaded page. Both writes go through `InfiniteEntry.setData(..., { track: false })` (`infinite.ts:974-1007`), which keeps `pageParams` length-aligned with the pages by trimming or padding with the last param, or with `initialPageParam` when the entry held none. Pinned by `packages/core/tests/infinite.test.ts`, "InfiniteQuery peek / write / replace — parity with Query".

## Consequences to preserve

- Each method reports its own `WriteEvent.source` to plugins: `'optimistic'` for `setData`, `'rollback'` when its snapshot rolls back, `'commit'` when it is finalized, `'write'` for `write` and `'replace'` for `replace` (`client.ts:1786-1947`). A commit is reported once no optimistic layer on the entry is live, so its data holds no pending guess (`../entities/entry.md`). The app's own writes carry `origin: undefined`, so cross-tab mirrors all four by default and entities walks every one. `crossTabPlugin({ optimistic: false })` keeps the first two in their tab. Pinned by `plugin-host.test.ts`, "fetch, optimistic, rollback, write and replace each report their source"; the vocabulary is in `../flows/plugin-lifecycle.md`.
- The devtools `cache:set-data` event uses the same `source` values. A `write` inside a mutation's `onMutate` reports `'write'` and inherits the ambient `causeId`; its *kind* stays a plain canonical write.
- The supersede rule belongs to the replace paths alone: `replaceData` (`client.ts:1842-1863`), `replaceInfiniteData` (`client.ts:2115-2129`), the host's `replace` through `writeByKey` (`client.ts:1186-1189`, `client.ts:1209-1211`) and `LocalCache.replace` (`local.ts`). Each calls `entry.supersedeByWrite(...)`, and only when the write left the entry holding data, one rule for both kinds since 1.0. Those are the only supersedes among the write methods. `writeData` does not supersede. Its comment said both for a month: `e8933dd` (0.7.2) rolled the behaviour back and added the patch paragraph, but left `314aa28`'s "a canonical write SUPERSEDES" above it. The code was never ambiguous — the reconciled comment now says what it does. `host.queries.write`, the plugin path, is a patch too and leaves a fetch in flight alone. Cross-tab applies a peer's message through it, so a relayed write never supersedes this tab's own fetch: it carries another tab's write, not this tab's server truth.
- `hasPendingMutations` is purely observational (nothing in core gates on it), so this was never a correctness bug in the engine — it was a wrong-state report plus unbounded retention. Both are gone for callers who use the right method.

## A superseding `replace` can discard a reconciliation

A `replace` discards the fetch in flight on the claim that the fetch has nothing left to add. That claim fails for one kind of fetch: an invalidation's. A reconnect's `invalidateAll()` asks for everything the app missed, and a push folded in with `replace` mid-fetch threw that away while carrying only its own record. The BACKLOG item "A superseded catch-up refetch is discarded, not re-run" recorded it, and a code reviewer reproduced it: the missed data never arrived, and the entry stayed stale with no fetch coming.

"Supersede without aborting" was not an answer, because the result would still be discarded. So since 1.0 `supersedeByWrite` re-fetches once when the entry is force-stale and still has subscribers. A `replace` during that catch-up leaves it in flight, because otherwise a burst of pushes would cancel and restart it forever. Its response is server truth and lands over those writes. `await invalidate()` settles with the catch-up. The mechanics are in `../entities/entry.md`; pinned by `catch-up-refetch.test.ts`.

## Only a canonical write counts toward freshness

The split carries a third consequence: which writes restart the stale clock. A canonical write is server truth, so `write` and `replace` set `serverUpdatedAt`, and staleness counts from it. A `setData` is a guess, so it moves `lastUpdatedAt` and leaves the clock alone (spec §5.9).

Until the 1.0 third pass the subscribe-time check read `lastUpdatedAt`, so a guess reset freshness. Past `staleTime`, a new subscriber skipped its refetch while the guess was live, after its rollback and after its finalize, and the rolled-back case showed old server data as fresh. The `isStale` signal read `true` throughout, so the two disagreed. While a guess is live, a staleness-driven fetch now waits and runs once the last live guess settles; `../entities/entry.md` has the mechanics. Pinned by `optimistic-staleness.test.ts`.

## `LocalCache` has the canonical writes too

`LocalCache` had only `setData`, so a canonical patch to a local cache was `setData(...).finalize()`. reader-ssr's composer forgot the `.finalize()`, and every post left `hasPendingMutations` true. `write` and `replace` on `LocalCache` (1.0) mirror `Query`'s, so the right call is the obvious one. Pinned by `local-cache-writes.test.ts`.
