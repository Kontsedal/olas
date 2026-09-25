---
name: shared-storage-whole-writes
description: A plugin that writes its whole in-memory copy over one storage key deletes what other tabs wrote since it read the key; read and merge before each write.
type: pitfall
covers:
  - packages/persist/src/query-cache.ts:249-349
edges:
  - { type: related, target: ../modules/persist.md }
  - { type: tested-by, target: ../../packages/persist/tests/query-cache.test.ts }
last_verified: 2026-09-25
confidence: medium
---

# A whole write to a shared key deletes the other tabs' rows

## The trap

Browser storage is per origin, so every tab of an app writes the same keys. A plugin that keeps a map in memory and writes the whole map under one key treats the key as its own. It reads storage once, at startup, and from then on each write replaces the key with the map.

Tab B starts and reads the key. Tab A starts later, writes its own row, and storage now holds both. Tab B's next write carries only what B read at startup and what B wrote since. Tab A's row is gone, and nothing in either tab reports it.

The same write loses a second way. Tab B restored an old copy of an entry at startup, and tab A fetched a fresh one since. Tab B's write puts its old copy back over A's fresh one.

`persistQueryCachePlugin` had both until the third 1.0 review. Tests with one root never show it, because a single tab's map and its storage agree.

## The fix

Read the key before each write, and merge:

- **Rows the writer never touched stay.** They belong to another tab, or to a session that has not bound them yet.
- **A row both sides hold goes to the newer one.** The query cache compares `lastUpdatedAt`. "This session wins" would put a restored copy over a peer's fetch.
- **A deletion needs a tombstone with a time.** Leaving a row out of the map no longer deletes it, since the merge reads it back. Record what was removed and how old it was, and drop a stored row that old or older. A newer row is a peer's, and stays.

`merge` in `packages/persist/src/query-cache.ts:249-264` is the worked example, and `flush` (`query-cache.ts:345-349`) reads before it writes.

## What the fix does not buy

The read and the write are two steps. Two tabs that write at the same moment can each read before the other writes, and one row drops out. The merge makes that loss temporary: each write carries every row its tab wrote, so the owner's next write restores it. Closing the window needs a lock around the read and the write, such as a Web Lock, or storage with transactions across tabs.

## How to spot it

Look for a `storage.set(key, JSON.stringify(everything))` whose `everything` is built from memory alone. Test it with two roots on one storage adapter, each writing a different row.
