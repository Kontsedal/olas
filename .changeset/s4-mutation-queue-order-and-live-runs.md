---
"@kontsedal/olas-mutation-queue": patch
---

**A replay keeps the order of a mutation id, keeps a newer draft, and leaves another tab's live runs alone.**

- An entry that stays on disk ends its group's replay pass: a failure worth a retry, or a run executing it. The group's later entries wait for the next pass. A later draft used to reach the server first, and the next pass sent the older draft after it.
- A success deletes a `dedupeBy` entry only when no newer run's variables ride on it. A replay whose entry a collapse rewrote while it was sending keeps the entry, in this tab or when the key belongs to another tab. A live run's success hands the entry to a newer run collapsed onto it that is still sending. Either success used to delete the newer draft, so a failure of that draft left nothing for the next load.
- A live run marks its entry as its tab's until it settles, with a Web Lock, or a `localStorage` lease a heartbeat refreshes where Web Locks is missing. A replay pass in another tab skips a marked entry. The replay lock covered replays only, so a pass used to send a request another tab still had out. A closed tab's locks are released and a lease without a heartbeat expires after 30 seconds, so a dead tab's entries still replay.
- A `localStorage` lease dated more than 30 seconds in the future no longer counts as held. Such a lease, which only other code writing to storage can leave, used to block every replay pass for good.
- The devtools lane reports `in-other-tab` for an entry a run in another tab marked, and `waiting` for each entry a group leaves behind a kept one.
