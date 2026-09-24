---
name: mutation-queue
description: "@kontsedal/olas-mutation-queue — an OlasPlugin that persists meta.persist mutation runs before they go out and replays survivors through the core runner, on reload, on reconnect and on demand, coordinated across tabs."
type: module
covers:
  - packages/mutation-queue/src/index.ts
  - packages/mutation-queue/src/plugin.ts
  - packages/mutation-queue/src/protocol.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/plugin.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/coverage-lifecycle.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/coverage-replay-lock.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/backoff-dispose.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/security.test.ts }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: persist.md }
last_verified: 2026-09-25
confidence: high
---

# `@kontsedal/olas-mutation-queue`

An `OlasPlugin` that persists every run of a `defineMutation({ meta: { persist: true } })` to a `StorageAdapter` from `@kontsedal/olas-persist`, and replays the runs that never settled. Spec §13.3.

- `mutationQueuePlugin(options)` returns the plugin (`packages/mutation-queue/src/plugin.ts:176-961`). It throws at once on an empty `keyPrefix` (`plugin.ts:190-192`), and its `setup` throws without a query engine (`plugin.ts:199-204`).
- `MutationQueue` is the scope of its service, `{ replayNow(): Promise<void> }` (`plugin.ts:19-34`). Read it with `ctx.inject(MutationQueue)` or `root.inject(MutationQueue)`.
- `MUTATION_QUEUE_PLUGIN_NAME = 'olas-mutation-queue'` is the plugin's name and the `origin` of its replays (`plugin.ts:13`).
- `index.ts:1-10` adds `persist?: boolean` to `MutationMeta` through `declare module`.

The wire format is `QueueEntry` in `protocol.ts` (`PROTOCOL_VERSION = 1`), stored under `<keyPrefix>/<mutationId>/<runId>`.

```ts
import { createMutation, createRoot, defineController, defineMutation, queryEngine } from '@kontsedal/olas-core'
import { MutationQueue, mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

const createOrder = defineMutation({
  id: 'orders/create', // registers the definition, so a replay can find it
  meta: { persist: true },
  mutate: async (order: { sku: string }, { signal }) => {
    const res = await fetch('/orders', { method: 'POST', body: JSON.stringify(order), signal })
    return res.json()
  },
})

const app = defineController((ctx) => ({
  place: createMutation(ctx, createOrder),
  retryNow: () => ctx.inject(MutationQueue).replayNow(),
}))

export const root = createRoot(app, {
  deps: {},
  queries: queryEngine(),
  plugins: [mutationQueuePlugin({ storage: localStorageAdapter(), keyPrefix: 'shop/mutations/v1' })],
})
```

## Lifecycle of a live run

The plugin reads live runs through `onMutation` and `wrapMutate` (`plugin.ts:914-936`). `onMutation` ignores its own replays, which carry `origin: 'olas-mutation-queue'`. It also ignores runs without an `id` or without `meta.persist: true`.

- **`'start'`** → `onStart` (`plugin.ts:810-844`) records a `QueueEntry` in `unwritten` and nothing more, because `onMutation` is synchronous and cannot await a write.
- **The first attempt** → `wrapMutate` takes the recorded entry at `attempt === 0` and awaits `writeEntry` before it calls `next()` (`plugin.ts:915-927`). So the entry is durable before the request goes out. A failed write is reported through `onWarn`, and the run proceeds without durability.
- **Settle** → `onSettle` (`plugin.ts:846-912`):
  - `'success'` deletes the entry and clears its dedupe key.
  - `'error'` deletes and clears only when `attempts >= maxAttempts`, and reports `onReplayError`. Otherwise it keeps the entry for a replay on a later load.
  - `'cancel'` keeps the entry and the dedupe key, because a reload mid-run looks like a cancel to the plugin.

Every settle branch acts on `ownerRunId`, not `event.runId`; see the next section. Pinned by "persists an entry on enqueue and deletes on success", "leaves the entry in storage on error so the next reload replays", and the "the entry is durable before mutate runs" group ("mutate waits for the storage write to resolve", "a rejected write is reported, and the run still proceeds").

## One entry per logical operation (0.9 review)

Three rules keep a single durable entry behind one user intent. All three live in `plugin.ts`.

1. **A successful run supersedes the failed runs it retries.** A run that settles in error below `maxAttempts` keeps its entry for a later load. Its `runId` goes into `retainedFailures`. When a later run of the same logical operation succeeds, `dropSupersededFailures` deletes those entries (`plugin.ts:387-401`). Without it, a user who pressed the button again, with a new `runId`, left the first entry on disk, and the next page load wrote the order twice. `identityOf` defines "the same operation" (`plugin.ts:276-287`): `dedupeBy` when configured, otherwise the mutation id plus the JSON form of the variables. A retry re-submits the same variables, while a different operation carries different ones. Only runs that already settled are eligible, so a second concurrent submit of identical variables keeps its own entry, and a `'cancel'` run keeps its own by design.
2. **A `dedupeBy` collapse settles the entry it collapsed onto.** The collapsed run writes nothing, so `runAlias` maps its `runId` to the owner's, and every settle branch resolves through it. Before this, the collapsed run's success deleted a key that was never written and left the owner to replay.
3. **A replay skips runs executing in this tab.** `inFlightRuns` maps each live `runId` to the `runId` of the entry backing it. `replayEntry` returns early when the entry it is about to replay is in flight (`plugin.ts:520-526`). Without that, an `online` event or a `replayNow()` inside the start-to-settle window would send a live request twice. This covers one tab only. Overlap between tabs is the replay lock's problem, and after that the server's idempotency key's.

Pinned by the `plugin.test.ts` groups "a manual retry must not leave a second entry" and "replay skips runs executing in this tab".

## Replay

Three triggers funnel into `runReplay` (`plugin.ts:779-789`), which a `replaying` flag keeps from overlapping and `withReplayLock` keeps from overlapping across tabs:

- **Startup.** `setup` starts a pass (`plugin.ts:800-801`). It is `host.track`ed when the tab starts online, so `root.waitForIdle()` waits for it. An offline pass parks until reconnect, and tracking it would hold `waitForIdle` for that long.
- **Reconnect.** `host.network.onReconnect` starts a pass (`plugin.ts:792-794`), so in-session failures retry when the network returns. The host removes the subscription when the plugin disposes.
- **On demand.** `MutationQueue`'s `replayNow()` (`plugin.ts:795`).

`replayAll` (`plugin.ts:703-772`) lists the entries under the prefix, drops the ones past `ttlMs`, waits for `host.network.isOnline()`, and groups the rest by mutation id. Each group runs in `seq` order, serially, and different ids run in parallel. `replayEntry` (`plugin.ts:518-607`) then:

1. reads the definition through `host.mutations.get(id)`. A missing one reports `onReplayError` and leaves the entry for a later load;
2. drops an entry whose definition lacks `meta.persist: true`, or one already at `maxAttempts`;
3. writes the entry back with `attempts + 1` before running, so a crash mid-run cannot loop on it;
4. runs it with `host.mutations.run(id, variables)`, the core runner. The definition's `retry` applies, `mutate` receives the root's `deps`, the run counts toward `waitForIdle`, and devtools reports it under the path `['plugin', 'olas-mutation-queue']` (`packages/core/src/query/client.ts:921-929`). Its events carry the plugin's name, so `onMutation` does not persist the replay a second time.
5. on success, deletes the entry and calls `onReplaySettle(entry, result, queries)`. A throw from that handler goes to `onWarn`.
6. on failure, drops and reports at `maxAttempts`, or calls `onReplayAttempt`. An abort, or the plugin disposing mid-run, counts as no attempt.

`onReplaySettle` receives the root's `QueryHost`, so a reconciliation invalidates in this root only. It addresses entries by query id and **`key(...)` output**, as every `QueryHost` method does: `queries.invalidate('orders/list', [])`. Pinned by "onReplaySettle fires with the result and the root query host after a successful replay", which also checks that a second live root does not refetch.

## Cross-tab coordination and reconnect (T6.2)

- **Replay on reconnect, not only on reload.** See the triggers above. Pinned by "replay waits for offline, then fires on the online event" and "replayNow() re-drives a pending entry in-session".
- **One tab replays at a time** (`withReplayLock`, `plugin.ts:663-693`). It prefers Web Locks, through `navigator.locks.request(name, { ifAvailable: true }, …)`. A tab that cannot get the lock skips the pass, and the holder replays every entry under the shared prefix. Without Web Locks it falls back to a TTL'd `localStorage` lease with a heartbeat (`acquireLease`, `releaseLease`, `plugin.ts:1012-1046`). Node and SSR have neither, so they run uncoordinated. This is **best-effort, not exactly-once**: the lease leaves a double-replay window, and the server's idempotency key is the real gate. Pinned by `coverage-replay-lock.test.ts`.
- **Cache reconciliation** is `onReplaySettle`, above. Without it, subscribers show stale data until their `staleTime` lapses.

## Other honesty fixes (T6.2 and after)

- **`seq` is seeded from `Date.now()` in `setup`**, as `let seqCounter = Date.now()` (`plugin.ts:217`). An enqueue that races the startup pass therefore still sorts after entries from the previous session. `replayAll` also raises the counter to the highest `seq` on disk, as a safety net for two tabs in the same millisecond.
- **`activeKeys` clears only when the entry drops**: on success, and on an error at `maxAttempts`. It stays on `'cancel'` and on an error below the limit. Otherwise a re-enqueue after a cancel mid-run would write a second durable entry for the same operation.
- **`dispose()` releases a pass parked on the offline wait.** `waitForOnline` registers its resolver in `onlineWaiters`, and `dispose()` trips every one (`plugin.ts:938-957`). The wait sits inside `withReplayLock`, so a tab that disposed while offline used to hold the cross-tab lock until a network that may never return. `dispose()` wakes the backoff sleepers the same way. Pinned by "dispose() drops every online listener, including the parked replay pass" and `backoff-dispose.test.ts`.
- **A delete waits for the write it follows.** `pendingWrites` holds each in-flight write by `runId`, and `deleteEntry` awaits it (`plugin.ts:361-378`). A run that settles before its write lands therefore leaves no phantom entry.

## Option surface

`plugin.test.ts` and `coverage-lifecycle.test.ts` cover the options:
- `dedupeBy` collapses on an idempotency key;
- `ttlMs` drops expired entries and reports `ttl-expired` through `onReplayError`;
- `backoffMs` and `maxBackoffMs` give exponential backoff across loads;
- `onReplayAttempt` fires on a failure below the limit;
- `migrate` ports an entry from an earlier `PROTOCOL_VERSION`;
- `maxEntryBytes` is a soft cap reported through `onWarn`.

The online gate and `seq` ordering are covered too. The unit tests drive `onMutation` and `wrapMutate` through a `directHooks` fake host (`plugin.test.ts:57-122`). Replay tests wait with `root.waitForIdle()`, since the startup pass is tracked.

## Limitations

The queue does not order runs across mutation ids. Different ids replay in parallel, and tabs do not coordinate order. Model dependent steps under one mutation id, or make the server tolerate any order. Tracked in `BACKLOG.md`.

## Replaying stored entries safely (1.0)

Storage is state other same-origin code can write, so replay checks it:
- **Only opted-in mutations run.** `replayEntry` reads the definition through `host.mutations.get(id)` and drops an entry whose definition lacks `meta.persist: true` (`plugin.ts:541-554`).
- **The key must match the contents.** `listEntries` drops an entry stored under a key other than `entryKey(mutationId, runId)` (`plugin.ts:461-511`). Every later write and delete goes by that key, so a mismatched entry was never removed and replayed on every load. A migrated entry is rewritten under its new key and its old key deleted, so a `migrate` that renames the mutation runs once.
- **Every field is checked** by `isValidEntry` (`plugin.ts:410-427`): a whole, non-negative `attempts`, a finite `seq`, and an `enqueuedAt` at most `CLOCK_SKEW_MS`, five minutes, ahead. Migrated entries go through the same check.

Pinned by `tests/security.test.ts`; the review is `../decisions/trust-model.md`.
