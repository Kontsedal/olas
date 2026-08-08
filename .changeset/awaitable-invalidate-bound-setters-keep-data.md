---
"@kontsedal/olas-core": minor
---

Three ergonomics improvements surfaced by integrating olas into a real app:

- **`invalidate()` / `invalidateAll()` now return `Promise<void>`** (was `void`) — on `Query`, `InfiniteQuery`, and `LocalCache`. The promise resolves when the refetch(es) they trigger have **settled** (immediately for a subscriber-less entry, which is marked stale but not refetched), and **never rejects** — a fetch error routes to the root's `onError` and stays on the entry's `error` signal. This makes `await query.invalidate(id)` a valid sequencing point ("the refresh I asked for has completed"), matching TanStack's `invalidateQueries`. Non-breaking: fire-and-forget callers that ignore the return keep working.

- **`signal.set` / `signal.update` and `Field.set` are now bound** — stable-identity instance methods, so passing one as a value (`onChange={signal.set}`, `const setName = field.set`) no longer throws `Cannot read properties of undefined (reading 'inner')` the moment it's detached. Same guarantee as React's `setState`.

- **New `keepDataWhileDisabled` option** on `ctx.use(query, { enabled, keepDataWhileDisabled: true })` — keeps the subscription reporting its last `data` (snapshotted when `enabled` goes false) instead of blanking to `undefined`, mirroring react-query's "a disabled observer still reads the cache" behaviour for flows that would otherwise flash empty. The entry is still released (refcount / GC unchanged) and `status` stays `'idle'`; only `data` is retained (`error` is not). Defaults to `false` — existing disabled-query behaviour is unchanged.
