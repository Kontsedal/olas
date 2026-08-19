---
'@kontsedal/olas-core': patch
---

**`query.write(...)`'s supersede guard is asked after the write, not before.** 0.7.0 superseded an in-flight fetch only when the entry *already* held canonical data. That declined to supersede in the commonest shape of the bug it was written for: open a thing, act on it, and the push carrying the result is undone by the body read issued before the action — the entry has no data yet, so 0.7.0 left the stale answer to land.

The state the guard exists to prevent is `status: 'success'` over `undefined` with nothing in flight, which nothing refetches until `staleTime` lapses. That is reached exactly when a write both supersedes the fetch *and* leaves `data` undefined — so the post-write value is the precise test, and the pre-write one is a proxy that is wrong in both directions.

- A full-body write onto an entry whose first load is outstanding **now supersedes**. Nothing is stranded: the write supplies the value the fetch would have.
- A merge that cannot patch what is not there (`prev ? fn(prev) : prev`, the usual shape over a possibly-absent key) leaves `undefined` and **still does not** supersede — that fetch is what will produce the first value.

`Entry.hasCanonicalData()`, added in 0.7.0 for the old guard, is removed: it has no remaining caller and the post-write test does not need it. It was internal, never exported from the package, which is why this is a patch rather than a minor.

Found by upgrading a real consumer to 0.7.0 — its own regression tests for the bug 0.7.0 was written to fix went red, because they cover the first-load case.
