---
name: canonical-vs-optimistic-writes
description: Why the Query handle has two write methods — setData (optimistic, returns a Snapshot) and write (canonical, none) — instead of one with an options bag.
type: decision
covers:
  - packages/core/src/query/types.ts:297-380
  - packages/core/src/query/client.ts:1281-1345
  - packages/core/src/query/define.ts:103-140
  - packages/core/src/query/entry.ts:486-520
edges:
  - { type: tested-by, target: ../../packages/core/tests/query.test.ts }
  - { type: uses, target: ../entities/entry.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-08-12
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

## Why `write` still creates a missing entry

`setEntryData` (the plugin path) drops silently when no entry exists; `write` binds one, exactly as `setData` does. The reason is symmetry: `write` is `setData` minus the snapshot, and diverging on entry creation would make it a second, subtly different write. Callers that must not patch an absent key have `peek(...)` as the guard — and a merge over `undefined` is usually the shape that needs it.

## Consequences to preserve

- `write` emits the same `SetDataEvent` with `source: 'set'` as any local write, so cross-tab and entity plugins treat it identically (matching `setEntryData`'s documented behaviour, spec §13.2).
- Its devtools event is explicitly `'set'`, never `'mutate'`, even when called inside a mutation's `onMutate` — it inherits the ambient `causeId` but its *kind* is a plain set.
- `hasPendingMutations` is purely observational (nothing in core gates on it), so this was never a correctness bug in the engine — it was a wrong-state report plus unbounded retention. Both are gone for callers who use the right method.
