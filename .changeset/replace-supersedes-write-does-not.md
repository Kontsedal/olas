---
'@kontsedal/olas-core': minor
---

**`query.replace(...keyArgs, value)` — a canonical write that supersedes an in-flight fetch — and `query.write(...)` goes back to leaving fetches alone.**

0.7.0 and 0.7.1 made `write` itself supersede. That is right for a whole record and wrong for a patch, and `write` cannot tell which it is being given: an updater reading `prev` describes the fields it touches and says nothing about the rest, so a response already on its way may be carrying newer values for them. Discarding it loses those. A downstream app folded a one-field push into a cached record while a refetch was outstanding, the refetch was discarded, and the field it would have brought never arrived — twice, in two unrelated suites, intermittently, because it is a race.

The distinction cannot be recovered inside the entry, because the updater's output looks identical either way. So it moves into the signature:

```ts
// A patch. Says nothing about the other fields, so an outstanding request still lands.
tabQuery.write(id, (prev) => ({ ...prev, title }))

// The whole record, as the server last stated it. An older request has nothing to add.
tabQuery.replace(id, tabFromServerPush)
```

- **`replace`** takes a value, not an updater — that is the claim that licenses superseding. It supersedes only when `value` is defined (replacing with `undefined` says "no record", and cancelling as well would strand the entry at `success` over no data).
- **`write`** is unchanged from 0.6.0 in this respect: it does not supersede. `cancel(...)` first is still the escape hatch when a caller has decided a patch should win.
- **`setData`** is untouched: an optimistic guess, which a server response may overrule (SPEC §5.5).

Kept from 0.7.x, both real fixes: a canonical write **rebases live optimistic snapshots** onto the written value, so a rollback restores that rather than an older baseline; and `prefetch()` **recovers from a supersede** the way `subscription.refetch()` has since T3.9, resolving with the entry's eventual value instead of rejecting with `AbortError`.

**Migration from 0.6.x**: none required. From 0.7.0/0.7.1: any `write` you were relying on to supersede becomes `replace` — the two seams that want it are typically a server push carrying a full record, and a just-created record returned by its own mutation.
