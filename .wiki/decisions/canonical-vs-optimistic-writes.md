---
name: canonical-vs-optimistic-writes
description: Why the Query handle has separate write methods — setData (optimistic, returns a Snapshot), write (canonical patch) and replace (canonical whole record) — instead of one with an options bag.
type: decision
covers:
  - packages/core/src/query/types.ts:336-413
  - packages/core/src/query/client.ts:954-987
  - packages/core/src/query/client.ts:1489-1623
  - packages/core/src/query/client.ts:1757-1827
  - packages/core/src/query/actions.ts:42-59
  - packages/core/src/query/entry.ts:507-560
  - packages/core/src/query/infinite.ts:81-114
  - packages/core/src/query/infinite.ts:696-765
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: ../flows/plugin-lifecycle.md }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-09-25
confidence: high
---

# Two write methods, not one

`Query` exposes both (`packages/core/src/query/types.ts:336-383`):

```ts nocheck
setData(...keyArgs, updater): Snapshot   // optimistic
write(...keyArgs, updater): void         // canonical
```

A third, `replace(...keyArgs, value)`, came later; see "Three write methods" below.

The core difference is whether a snapshot record is pushed (`Entry.setData`'s `{ track }`, `packages/core/src/query/entry.ts:522-532`), and that difference is load-bearing. A second follows from it. A canonical write rebases live optimistic snapshots onto its value, so a mutation that rolls back later restores the canonical data rather than an older baseline (`entry.ts:533-543`).

## Why `setData` alone was not enough

A snapshot exists to be **settled** by the mutation that created it. `onMutate` returns it, and the runtime finalizes on success and rolls back on error; see `mutation.ts`. That contract has no counterpart for a write with no mutation behind it: folding a server push into the cache, applying a realtime event, or syncing a value another view just changed.

With only `setData`, such a caller had three options, all bad:

1. Discard the `Snapshot`. Then the record stays **live** forever: `hasPendingMutations` wedged at `true` for the rest of the entry's life, plus one retained baseline per call. On a long-lived entry patched on every server event that array grows without bound — a real leak, not a cosmetic flag.
2. Call `snapshot.finalize()` at every call site. Correct, invisible in review when forgotten, and a strange thing to require of a write that was never optimistic.
3. Reach for the plugin API's canonical write, which already existed: `QueryClientPluginApi.setEntryData` then, `host.queries.write` in 1.0 (`packages/core/src/query/client.ts:954-987`). It is **plugin-facing**, addressed by query id and key rather than by the typed handle, and not part of the application surface.

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

`host.queries.write`, the plugin path, drops silently when no entry exists (`client.ts:962-963`); `write` binds one, exactly as `setData` does. The reason is symmetry: `write` is `setData` minus the snapshot, and diverging on entry creation would make it a second, subtly different write. Callers that must not patch an absent key have `peek(...)` as the guard — and a merge over `undefined` is usually the shape that needs it.

## Infinite queries have the same three doors

`InfiniteQuery` gained `peek`, `write` and `replace` in 1.0 (`packages/core/src/query/infinite.ts:81-114`, `client.ts:1757-1803`). The rules carry over unchanged: `write` patches the pages and leaves an in-flight fetch alone, and `replace` takes whole pages and cancels it. `peek` returns `undefined` for a missing entry or no loaded page. Both writes go through `InfiniteEntry.setData(..., { track: false })` (`infinite.ts:700-765`), which keeps `pageParams` length-aligned with the pages by trimming or padding with the last param. Pinned by `packages/core/tests/infinite.test.ts`, "InfiniteQuery peek / write / replace — parity with Query".

## Consequences to preserve

- Each method reports its own `WriteEvent.source` to plugins: `'optimistic'` for `setData`, `'rollback'` when its snapshot rolls back, `'write'` for `write` and `'replace'` for `replace` (`client.ts:1509-1623`). The app's own writes carry `origin: undefined`, so cross-tab mirrors all four by default and entities walks every one. `crossTabPlugin({ optimistic: false })` keeps the first two in their tab. Pinned by `plugin-host.test.ts`, "fetch, optimistic, rollback, write and replace each report their source"; the vocabulary is in `../flows/plugin-lifecycle.md`.
- The devtools `cache:set-data` event uses the same `source` values. A `write` inside a mutation's `onMutate` reports `'write'` and inherits the ambient `causeId`; its *kind* stays a plain canonical write.
- The supersede rule belongs to the replace paths alone: `replaceData` (`client.ts:1560-1579`), `replaceInfiniteData` (`client.ts:1789-1803`) and the host's `replace` through `writeByKey` (`client.ts:968`, `client.ts:985`). Those are the only `entry.cancel()` calls among the write methods. `writeData` does not supersede. Its comment said both for a month: `e8933dd` (0.7.2) rolled the behaviour back and added the patch paragraph, but left `314aa28`'s "a canonical write SUPERSEDES" above it. The code was never ambiguous — the reconciled comment now says what it does. `host.queries.write`, the plugin path, is a patch too and leaves a fetch in flight alone. Cross-tab applies a peer's message through it, so a relayed write never supersedes this tab's own fetch: it carries another tab's write, not this tab's server truth.
- `hasPendingMutations` is purely observational (nothing in core gates on it), so this was never a correctness bug in the engine — it was a wrong-state report plus unbounded retention. Both are gone for callers who use the right method.
