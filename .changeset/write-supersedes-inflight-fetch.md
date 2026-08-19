---
'@kontsedal/olas-core': minor
---

**`query.write(...)` now supersedes an in-flight fetch.** A canonical write is newer by definition: the caller is folding in something the server has already said, while an outstanding request was issued before that happened and will answer with the state from before it. Until now that response landed last and silently undid the write — the value appeared, then vanished, with a perfectly valid server payload as the cause and nothing in the UI to explain it.

This is a behaviour change to an existing API, and a deliberate divergence from react-query, whose `setQueryData` is clobbered the same way (measured against `@tanstack/query-core` 5.101). react-query cannot do otherwise: it has **one** door for both meanings, so it cannot tell an optimistic guess from server truth. olas has two, which is what makes the distinction expressible:

- **`write`** — canonical. Supersedes the in-flight fetch, and rebases any live optimistic snapshots onto the written value so a later rollback restores it rather than an older baseline.
- **`setData`** — optimistic. Unchanged: a guess, which a server response is entitled to overrule, so the cancel-before-`setData` recipe (SPEC §5.5) is still the caller's to make.

**It supersedes only when the entry already holds _canonical_ data.** With none, the in-flight fetch is not a stale answer to discard — it is what will produce the entry's first value, and cancelling it would leave `status: 'success'` over `undefined` data with nothing to refetch it until `staleTime` lapses: a query that never loads. "Canonical" is load-bearing — an optimistic `setData` over a never-loaded entry sets `data` too, and cancelling on the strength of a guess reaches that same stranded state by another route.

**Two known limits.** A query whose fetcher legitimately resolves `undefined` never supersedes (the cache spells "nothing here" as `undefined` throughout), so call `cancel(...)` first on one of those. And a superseded fetch is *discarded*, not re-run: if the outstanding request was a reconnect catch-up, that resync does not happen and the write carries only its own delta — `await invalidateAll()` still resolves, so a caller cannot detect it from the promise. Both are in SPEC §6.4; the second is tracked in `BACKLOG.md`.

`query.prefetch()` also gained the AbortError recovery `subscription.refetch()` has had since T3.9: a prefetch superseded by a write now resolves with the entry's eventual value instead of rejecting.

```ts
// Before: needed a cancel, and every call site had to remember it.
tabQuery.cancel(id)
tabQuery.write(id, () => tabFromServerPush)

// Now:
tabQuery.write(id, () => tabFromServerPush)
```

**Migration.** Existing `cancel(...)` calls before a `write` are now redundant but harmless — `cancel` stays unconditional, so it still holds back a first load if that is genuinely what you want. Remove them at leisure. If you were relying on a fetch overwriting a `write` (unlikely — that was the bug), switch that site to `setData` and settle its snapshot, or re-invalidate after the write.

Found by shipping it: two product bugs in a consumer app — a query-result grid blanking a moment after the results arrived, and a tab, split or panel-close undoing itself — plus a CI suite quarantined for two days over failures that were all this one cause.
