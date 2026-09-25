---
"@kontsedal/olas-core": minor
---

**Plugins see the server truth beneath a guess, and can make a guess of their own.**

- `WriteEvent.server` is the entry's server truth after the write, as `dehydrate()` ships it. It holds the data beneath every live optimistic write, when the server last said it, and the server pages' params for an infinite query. While an optimistic write is live, `data` holds the guess whatever the source is. A `'write'` made under a guess carried it to a persister, and the rollback that corrected it was a source such a plugin skips. With no optimistic write live, `server` holds the same value as `data`.
- `host.queries.setData(id, key, updater, options?)` is an optimistic write, as `setData` in `onMutate`. It returns the `Snapshot` the plugin settles with `rollback()` or `finalize()`, reports `'optimistic'`, and leaves the stale clock and a fetch in flight alone. A relay uses it to show another tab's guess as a guess. It returns `undefined` when the root holds no entry for the key.
