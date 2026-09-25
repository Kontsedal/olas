---
"@kontsedal/olas-core": minor
"@kontsedal/olas-mutation-queue": minor
---

**Cache identity and root isolation.**

- **`bindQuery(ctx, query)` and `root.bindQuery(query)` scope query operations to one root.** They cover regular and infinite queries. With more than one root, an unbound helper such as `userQuery.invalidate(...)` throws. In 0.8 it broadcast writes to every root or read an arbitrary root's data. A bound `prefetch` works before anything subscribes. A bound operation rejects after its root is disposed.
- **Cache keys encode every value with a type tag.** A special value can no longer collide with a user's string or object. Special values include `undefined`, `NaN`, a `Date` and a `bigint`. Any hash an app stored outside the process must be rebuilt.
- **`-0` in a cache key is `0`.** Arithmetic produces `-0`, every equality callers use treats it as `0`, and JSON, the SSR transport, cannot represent it. Keeping it distinct split entries and broke hydration.
- **One expiry scheduler runs every duration:** staleness, gc, `refetchInterval`, the `retryDelay` backoff and `suspend({ maxIdleTime })`. `staleTime: Infinity` and `gcTime: Infinity` schedule no timer. A finite delay above the platform's 32-bit timer limit is split into chunks. In 0.8, each of these clamped to about 1 ms. The longest settings then behaved as the shortest: a cache stale on arrival, an entry collected on the next tick, or a poll storm.
- **mutation-queue:** a replay's invalidation reaches only the root the plugin is installed on.

Unbound `query.peek()` throws under multiple roots, where 0.8 neither threw nor warned. Check hot-path `peek` call sites when upgrading. `MIGRATING.md` covers the migration.
