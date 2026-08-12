---
'@kontsedal/olas-core': minor
---

Two additions to the module-level `Query` handle, both surfaced by integrating olas into a real app — and one correctness distinction they make expressible.

- **`query.peek(...keyArgs): T | undefined`** — read a keyed entry's cached data synchronously. Completes the imperative surface: `setData` and `cancel` could already reach a keyed entry from outside a subscription, while nothing could *read* one. A peek never creates an entry (so asking cannot change the answer), never fetches, and registers **no reactive dependency** — inside a `computed` or an effect it will not cause a re-run. `undefined` means there is nothing to read: no entry (never fetched, or gc'd), or an entry that has not settled. For imperative moments — an event handler that needs the current value, a guard before a write. Reactive reads remain `ctx.use(...)`'s job.

  ```ts
  // A click handler that needs the current value, without subscribing to it.
  function onOpen(id: string) {
    const cached = userQuery.peek(id)
    open(cached?.name ?? 'Loading…')
  }
  ```

- **`query.write(...keyArgs, updater): void`** — a **canonical** cache write: patches data, pushes no optimistic snapshot, leaves `hasPendingMutations` untouched. Otherwise identical to `setData` (same entry, created if absent; same `source: 'set'` plugin/devtools event, so cross-tab and entity plugins see it as any other local write).

  This is a correctness distinction, not sugar. A `setData` snapshot exists to be settled by the mutation that created it — `onMutate` returns it, success finalizes, failure rolls back. A **fire-and-forget** patcher (folding a server push into the cache, applying a realtime event, syncing a value another view just changed) has no mutation to settle it, so every call leaves a live snapshot record on the entry: `hasPendingMutations` wedged at `true` for the entry's remaining life, and on a long-lived entry patched per server event, a snapshot array that grows without bound. Before this, application code's only options were remembering `snapshot.finalize()` on every patch or the plugin-facing `setEntryData` (not reachable from userland).

  ```ts
  // Server pushed a record — canonical, nothing to roll back.
  events.on('user:updated', (u) => userQuery.write(u.id, () => u))
  ```

Also documented, because it produced a real (transient, self-healing, review-surviving) regression downstream: **"nothing invalidates this query" does not mean "no fetch is in flight"**, so the cancel-before-optimistic-`setData` step is not optional for un-invalidated queries. An entry refetches on its own whenever a subscription acquires it while stale — a first subscriber, a second root binding the same key, or a `resume()` after a suspend — with no invalidator anywhere. `setData`'s and `cancel`'s TSDoc, SPEC §5.5 and §6.4 now say so.

No behaviour changes to existing APIs.
