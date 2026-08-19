---
name: canonical-vs-optimistic-writes
description: Why the Query handle has two write methods — setData (optimistic, returns a Snapshot) and write (canonical, none) — instead of one with an options bag.
type: decision
covers:
  - packages/core/src/query/types.ts:297-380
  - packages/core/src/query/client.ts:1305-1360
  - packages/core/src/query/define.ts:103-140
  - packages/core/src/query/entry.ts:486-520
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-08-19
confidence: high
---

# Two write methods, not one

`Query` exposes both:

```ts
setData(...keyArgs, updater): Snapshot   // optimistic
write(...keyArgs, updater): void         // canonical
```

They differ in exactly one respect — whether a snapshot record is pushed (`Entry.setData`'s `{ track }`, `entry.ts:486-496`) — and that difference is load-bearing.

## Why `setData` alone was not enough

A snapshot exists to be **settled** by the mutation that created it: `onMutate` returns it, the runtime finalizes on success and rolls back on error (`mutation.ts`). That contract has no counterpart for a write with no mutation behind it — folding a server push into the cache, applying a realtime event, syncing a value another view just changed.

With only `setData`, such a caller had three options, all bad:

1. Discard the `Snapshot`. Then the record stays **live** forever: `hasPendingMutations` wedged at `true` for the rest of the entry's life, plus one retained baseline per call. On a long-lived entry patched on every server event that array grows without bound — a real leak, not a cosmetic flag.
2. Call `snapshot.finalize()` at every call site. Correct, invisible in review when forgotten, and a strange thing to require of a write that was never optimistic.
3. Reach for `QueryClientPluginApi.setEntryData` — the canonical-write path that already existed but is **plugin-facing** (`client.ts:905`), routed by `queryId` + `keyArgs` rather than the typed handle, and not part of the application surface.

Downstream evidence: one app accumulated eight such sites (server-push folds and execute-result patches) before the leak was noticed, and filed it as "mint a `writeTab` helper with `{ track: false }`" — i.e. it independently re-derived this method as userland glue it could not actually implement, since `track` was internal.

## Why not `setData(..., { track: false })`

The handle's signature is variadic — `setData(...args: [...Args, updater])` — so a trailing options bag is not cleanly expressible: with `Args` ending in an object type, TypeScript cannot tell the options from a key argument, and the runtime already recovers the updater positionally (`rest[rest.length - 1]`, `define.ts:104`). A second named method costs one line of surface and stays unambiguous at both the type level and the call site.

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

`setEntryData` (the plugin path) drops silently when no entry exists; `write` binds one, exactly as `setData` does. The reason is symmetry: `write` is `setData` minus the snapshot, and diverging on entry creation would make it a second, subtly different write. Callers that must not patch an absent key have `peek(...)` as the guard — and a merge over `undefined` is usually the shape that needs it.

## Consequences to preserve

- `write` emits the same `SetDataEvent` with `source: 'set'` as any local write, so cross-tab and entity plugins treat it identically (matching `setEntryData`'s documented behaviour, spec §13.2).
- Its devtools event is explicitly `'set'`, never `'mutate'`, even when called inside a mutation's `onMutate` — it inherits the ambient `causeId` but its *kind* is a plain set.
- The supersede rule belongs to `writeData` alone. `setEntryData` and `applyRemoteSetData` (plugin and cross-tab paths, `client.ts`) still write straight through: they have their own ordering contracts, and cross-tab in particular relays another tab's write rather than this tab's server truth.
- `hasPendingMutations` is purely observational (nothing in core gates on it), so this was never a correctness bug in the engine — it was a wrong-state report plus unbounded retention. Both are gone for callers who use the right method.
