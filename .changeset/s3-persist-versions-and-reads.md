---
"@kontsedal/olas-persist": patch
---

**`createPersisted` and `persistQueryCachePlugin` no longer overwrite storage they should keep.**

- `createPersisted` skips writing a migrated value back when another tab's change arrived during the load. The rewrite used to land over the change it had just applied, and the IndexedDB adapter broadcast the stale value to the other tabs.
- A payload from a newer `version` no longer reaches `migrate`, on load or from another tab. A step migrator passed it through unchanged, so an older build held the newer shape, and on load wrote it back under its own version. The source keeps its default, and storage keeps the payload.
- `persistQueryCachePlugin` holds its writes after a failed storage read, and the next flush reads storage again first. A transient read error used to make the next flush delete every stored entry this session had not bound.
- `persistQueryCachePlugin` drops a stored entry whose query the root has used and `include` now rejects, instead of writing it back until `maxAgeMs`.
- `indexedDbAdapter` uses the global `BroadcastChannel` only in a browser tab or web worker. On a server, a channel reaches every request in the process. Pass `broadcastChannel` to opt in anywhere.
