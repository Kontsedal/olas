---
"@kontsedal/olas-core": minor
"@kontsedal/olas-mutation-queue": minor
---

Harden cache identity and root isolation for 0.9.0.

- Add `ctx.bindQuery(query)` and `root.bindQuery(query)` for regular and infinite query operations scoped to one root. Unbound methods now fail on multiple roots instead of broadcasting writes or picking arbitrary data. Bound prefetch works before subscribing; bound operations reject after root disposal.
- Require an explicit stable `queryId` for SSR serialization. Anonymous queries are omitted and fetch on the client, preventing registration-order changes from hydrating the wrong query. In dev, `dehydrate()` warns when it skips cached entries for want of a `queryId`.
- Encode all cache-key values with type tags so special values cannot collide with user strings or objects. The exported `stableHash` encoding changes; rebuild any externally stored hash indexes.
- Route every user-supplied duration through one expiry scheduler: staleness, gc, `refetchInterval`, retry backoff (`retryDelay`) and `suspend({ maxIdle })`. `staleTime: Infinity` and `gcTime: Infinity` now schedule no timer at all, and any finite delay above the platform's 32-bit limit is chunked instead of overflowing. Previously all of these clamped to ~1ms, so the longest-lived settings behaved as the shortest — a stale-on-arrival cache, an entry collected on the next tick, or a poll storm.
- Normalize `-0` to `0` in cache keys. `-0` arrives from arithmetic rather than intent, every equality callers use treats it as `0`, and JSON (the SSR transport) cannot represent it — so distinguishing it only split entries and broke hydration.
- Scope mutation-queue replay invalidation to the plugin's owning root, and rename `ReplaySettleApi.invalidate`'s second parameter from `keyArgs` to `callArgs` — it always took the query's own arguments, not the tuple `key()` returns. The queue now requires core >=0.9.0.
- Include implementation entry points and TSX files in coverage, retaining the existing thresholds.

Unbound `query.peek()` now throws under multiple roots where 0.8 neither threw nor warned; audit hot-path `peek` call sites when upgrading.

See MIGRATING.md for the 0.8 to 0.9 API changes.
