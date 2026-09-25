---
name: success-drops-a-rewritten-entry
description: A durable entry that a newer write can rewrite must not be deleted by the success of an older send; compare a stamp written with each rewrite before the delete.
type: pitfall
covers:
  - packages/mutation-queue/src/plugin.ts:885-894
  - packages/mutation-queue/src/plugin.ts:1318-1335
edges:
  - { type: related, target: ../modules/mutation-queue.md }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/deliberate-cancel.test.ts }
last_verified: 2026-09-25
confidence: medium
---

# A success deletes the rewrite that came after it

## The trap

A durable queue keeps one entry per operation and rewrites it when a newer write of the same operation arrives. `@kontsedal/olas-mutation-queue` does this for a `dedupeBy` key: a run that collapses onto a settled run's entry rewrites it with its own variables (`holdFor`).

The rule "a success deletes the entry" assumes the entry still holds what succeeded. A send that started before the rewrite breaks that. The replay sends v1, the user saves v2, and v2 rewrites the entry. v1 succeeds, the success deletes the entry, and v2 is in flight with nothing on disk. When v2 fails, a reload finds no entry, and v2 is lost.

A live run has the same window. Two screens save one document, the second collapses onto the first run's entry while the first is still sending, and the first run's success deletes the entry.

## The fix

Before a success deletes the entry, check that the entry still holds what was sent:

- **A stamp written with each rewrite.** The queue uses the entry's `seq`: `holdFor` writes the collapsed run's `seq` with its variables. The replay compares the stored `seq` with the one it sent (`rewritten`, `packages/mutation-queue/src/plugin.ts:885-894`).
- **The in-memory copy first.** On an async store a rewrite in the same tab may not have landed yet. So the check also compares `current`, which is set when a write is issued.
- **For a live run, the newest rider.** A run collapsed onto a live owner writes nothing, so there is no stamp to read. The `'success'` branch of `onSettle` (`plugin.ts:1318-1335`) asks for a rider with a higher `seq` still executing, and hands the entry to it.

A changed entry stays, and the run that rewrote it settles it later.

## What is left

The stored check reads the entry and then deletes it, in two steps. A rewrite that lands between them is still lost. A conditional delete in storage would close it, and neither `localStorage` nor the `StorageAdapter` contract has one.

## How to spot it

A `delete(key)` after an `await` whose outcome belongs to an older version of what the key holds. Ask what can rewrite the key during the `await`.
