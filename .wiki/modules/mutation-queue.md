---
name: mutation-queue
description: "@kontsedal/olas-mutation-queue — an OlasPlugin that persists meta.persist mutation runs before they go out and replays survivors through the core runner, on reload, on reconnect and on demand, coordinated across tabs."
type: module
covers:
  - packages/mutation-queue/src/index.ts
  - packages/mutation-queue/src/plugin.ts
  - packages/mutation-queue/src/protocol.ts
  - packages/mutation-queue/tsdown.config.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: related, target: ../decisions/esm-only-build.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/plugin.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/coverage-lifecycle.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/coverage-replay-lock.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/backoff-dispose.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/security.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/retryable.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/async-storage-order.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/replay-order.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/devtools-lane.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/deliberate-cancel.test.ts }
  - { type: tested-by, target: ../../packages/mutation-queue/tests/serial-queue.test.ts }
  - { type: related, target: ../pitfalls/success-drops-a-rewritten-entry.md }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: persist.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-mutation-queue`

An `OlasPlugin` that persists every run of a `defineMutation({ meta: { persist: true } })` to a `StorageAdapter` from `@kontsedal/olas-persist`, and replays the runs that never settled. Spec §13.3.

- `mutationQueuePlugin(options)` returns the plugin (`packages/mutation-queue/src/plugin.ts:217-1480`). It throws at once on an empty `keyPrefix` (`plugin.ts:232-234`), and its `setup` throws without a query engine (`plugin.ts:238-246`).
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

The plugin reads live runs through `onMutation` and `wrapMutate` (`plugin.ts:1414-1448`). `onMutation` ignores its own replays, which carry `origin: 'olas-mutation-queue'`. It also ignores runs without an `id` or without `meta.persist: true`.

- **`'queued'`** → `onQueued` records the entry through `record` and starts `writeEntry` at once (`plugin.ts:1221-1279`). Core reports `'queued'` for a `serial` run waiting behind another. The write is not deferred, because the run ahead may hang or back off, and a reload in that window would lose the queue. The entry takes its `seq` now, so a replay keeps the call order. `record` puts the run in `inFlightRuns`, so a replay pass skips it while it waits. A queued run never collapses through `dedupeBy` and never takes a key; see "Queued serial runs" below.
- **`'start'`** → `onStart` (`plugin.ts:1281-1289`) returns at once for a run it saw queued. Otherwise it records a `QueueEntry` in `unwritten` and nothing more, because `onMutation` is synchronous and cannot await a write.
- **The first attempt** → `wrapMutate` takes the recorded entry at `attempt === 0` and awaits `writeEntry` before it calls `next()` (`plugin.ts:1414-1438`). For a queued run it awaits the write `onQueued` started, and for a collapse onto a settled run's entry it awaits the rewrite `record` started; `earlyWrites` holds both. So the entry holds the run's variables before the request goes out. A failed write is reported through `onWarn`, and the run proceeds without durability. When the run's `signal` has fired by the time the write settles, `wrapMutate` throws an `AbortError` instead of calling `next()`. A `latest-wins` supersede during a slow IndexedDB write otherwise let a `mutate` that ignores its signal send the stale request. Pinned by "a latest-wins run superseded while its entry is being written never calls mutate" in `async-storage-order.test.ts`.
- **Settle** → `onSettle` (`plugin.ts:1291-1411`):
  - `'success'` drops the entry through `dropEntry`, which also clears its dedupe key and its retained-failure record (`plugin.ts:582-586`). When a newer run collapsed onto the entry is still executing, the entry stays and takes that run's variables instead; see "A success keeps an entry a newer run rides on" below.
  - `'error'` drops when `attempts >= maxAttempts`, or when `isRetryable` rejects the failure, and reports `onReplayError` (`plugin.ts:1336-1378`). Otherwise it keeps the entry for a replay on a later load. A queued run that errors before `'start'` had its `onMutate` throw, so `mutate` did not run. Its entry goes, without `onReplayError`, as a run that did not wait persists nothing on the same failure.
  - `'cancel'` depends on `reason`; see "What a cancel means" below.

Every settle branch acts on `ownerRunId`, not `event.runId`; see the next section. Pinned by "persists an entry on enqueue and deletes on success", "leaves the entry in storage on error so the next reload replays", and the "the entry is durable before mutate runs" group ("mutate waits for the storage write to resolve", "a rejected write is reported, and the run still proceeds").

## One entry per logical operation (0.9 review)

Three rules keep a single durable entry behind one user intent. All three live in `plugin.ts`.

1. **A successful run supersedes the failed runs it retries.** A run that settles in error below `maxAttempts` keeps its entry for a later load. Its `runId` goes into `retained`. When a later run of the same logical operation succeeds, `dropSuperseded` deletes those entries (`dropSuperseded`, `plugin.ts:645-653`). Without it, a user who pressed the button again, with a new `runId`, left the first entry on disk, and the next page load wrote the order twice. `identityOf` defines "the same operation" (`plugin.ts:446-457`): `dedupeBy` when configured, otherwise the mutation id plus the JSON form of the variables. A retry re-submits the same variables, while a different operation carries different ones. Only runs that already settled are eligible, so a second concurrent submit of identical variables keeps its own entry. A run cancelled by dispose joins `retained` only when its identity comes from `dedupeBy`, where the key names the operation. With variable identity it keeps its entry, since two identical submits may be two intents.
2. **A `dedupeBy` collapse settles the entry it collapsed onto.** The collapsed run writes nothing, so `runAlias` maps its `runId` to the owner's, and every settle branch resolves through it. Before this, the collapsed run's success deleted a key that was never written and left the owner to replay. Once the owner has settled, the entry holds the newest collapsed run's variables; see "The entry holds the newest write" below.
3. **A replay skips runs executing in this tab.** `inFlightRuns` maps each live `runId` to the `runId` of the entry backing it. `replayEntry` returns early when `isEntryInFlight` says the entry it is about to replay is in flight (`plugin.ts:777-791`). Without that, an `online` event or a `replayNow()` inside the start-to-settle window would send a live request twice. A queued `serial` run is in `inFlightRuns` from `'queued'` on, so a pass skips it too, and the live queue sends it. A run in another tab is seen through the mark it puts on its entry; see "Live runs in other tabs" below. The replay lock covers replays only, so it never covered this.

Pinned by the `plugin.test.ts` groups "a manual retry must not leave a second entry" and "replay skips runs executing in this tab", and by "a replay pass skips a queued run: the live queue sends it" in `serial-queue.test.ts`.

## What a cancel means (1.0)

Core's `'cancel'` event carries a `reason`, and the `'cancel'` branch of `onSettle` reads it (`plugin.ts:1379-1410`):

- **`'superseded'` and `'reset'`** drop the entry through `dropEntry`. Both are the app discarding the run. Replaying it later would send a write the app replaced or withdrew. The entry stays while a run executing in this tab still rides on it (`isEntryInFlight`): a `dedupeBy` collapse that started before the cancel arrived wrote no entry of its own. When the cancelled run's variables are the ones the entry holds, `passToRider` gives it the newest rider's (`plugin.ts:619-623`).
- **`'dispose'`** keeps the entry and its dedupe key. The controller that owned the run is gone, and the write the user asked for is still wanted. A replay sends it, and a re-enqueue collapses onto it and rewrites it with its own variables. With a `dedupeBy` key the entry joins `retained`, so a later success under the key drops it.
- **A reload is not a cancel.** The root closes plugin delivery before it disposes anything, and a page unload emits nothing. The entry stays on disk, and the next load replays it.

Before the reason existed the queue kept every cancelled entry, on the premise that a reload mid-run looks like a cancel. It does not, so the cancels the queue saw were supersedes, resets and disposes. An autosave with `latest-wins` and `persist: true` left each superseded draft on disk. The next reconnect, `replayNow()` or load sent the stale draft after the newer one had landed, and the server ended on the older text. Pinned by `tests/deliberate-cancel.test.ts`.

## Queued serial runs (1.0)

A `serial` run waiting behind another used to report nothing until its turn came, and the queue writes on `'start'`. When the first request hung or backed off, storage held that request alone, and a reload lost every run queued behind it. Core now reports `'queued'`, and `onQueued` writes the entry then. The rest follows from that write:

- `reset()` rejects the queued runs and reports `'cancel'` with reason `'reset'` for each, so their entries go.
- The owning controller disposing reports `'dispose'`, so the entries stay and replay in `seq` order.
- A queued run whose `onMutate` throws reports `'error'` before `'start'`, and `onSettle` undoes the queue-time write (`plugin.ts:1337-1344`).

Pinned by `tests/serial-queue.test.ts`, including a reload that replays all three queued items in order.

**With `dedupeBy` (1.0, second review).** A queued run used to collapse onto the run ahead of it when both carried one key. It wrote nothing, and the run ahead settles before the queued run starts. Its success dropped the shared entry, so the queued run went out with nothing on disk and a reload lost it. A dispose kept only the first run's entry, so a replay sent the first draft alone. Now `record` takes a `queued` flag (`plugin.ts:1221-1269`). A queued run writes an entry of its own, stamped with its key, and never claims the key in `activeKeys`. Claiming it would let a run in another screen collapse onto an entry whose run has not started, with the same loss. When the owner is disposed, both entries stay, and a replay sends both in call order. A later success under the key drops both through `dropSuperseded`. Pinned by the "serial + dedupeBy" group in `serial-queue.test.ts`.

## The entry holds the newest write (1.0, second review)

An autosave with `latest-wins` and `dedupeBy` on the document id is the case this serves. A new draft B supersedes the draft A in flight, and B collapses onto A's entry, because A's cancel has not been reported yet when B starts. A's cancel then keeps the entry, since B rides on it. The entry used to keep A's variables, so a dispose of B, a retryable failure of B or a reload replayed A's stale draft. Two helpers keep the entry on the newest write:

- **`passToRider`** (`plugin.ts:619-623`) runs when the owner settles and its entry stays: a cancel with a rider in flight, a retryable error, or a dispose. It also runs when a rider whose variables the entry holds is withdrawn. It gives the entry the variables of the newest rider still in flight, by the `seq` in `riders`, through `newestRider` (`plugin.ts:626-636`). It does nothing while the owner still executes, because a collapse onto a live owner is two runs of one operation, and the owner's variables stand.
- **`holdFor`** (`plugin.ts:593-610`) does the rewrite. It keeps the owner's key, attempt count and `enqueuedAt`, takes the rider's variables and `seq`, and skips a write the entry already holds. `current` has the content each key was last asked to hold, set when the write is issued, so the rewrite builds on the newest one.
- **A collapse onto an entry kept for a replay**, after a dispose or a retryable failure, rewrites it at once in `record`. The run's first attempt waits for that rewrite through `earlyWrites`. Pinned by "a run that collapses onto the entry of a settled run goes out once the entry holds its variables" in `async-storage-order.test.ts`.

Until the third 1.0 review, an owner's success dropped the entry, riders or not, on the premise that a success under the key means the operation is done. Two screens that save one document under one key are two drafts, not one operation, so the premise did not hold; see the next section.

`writeEntry` now chains a second write to the same key behind the first (`plugin.ts:544-554`), so the rewrite lands after the original on an async storage. A rewrite and the original can both be in flight, and IndexedDB orders neither. Pinned by the "latest-wins + dedupeBy" group in `deliberate-cancel.test.ts`.

## A success keeps an entry a newer run rides on (third 1.0 review)

A `dedupeBy` collapse rewrites the entry it rides on with its own variables, once the run that wrote the entry has settled (`holdFor`). Two successes deleted that rewrite before its run had sent it. `../pitfalls/success-drops-a-rewritten-entry.md` has the general form.

- **A replay's success.** v1 fails with a 503 and is kept, with its key. `replayNow()` starts sending v1. The user saves v2, which collapses onto the entry and rewrites it, so storage holds v2. The v1 replay succeeds and drops the entry. v2 then fails with a 503, and a reload finds nothing. `rewritten` in `replayEntry` (`plugin.ts:885-894`) asks whether the entry changed since the replay wrote `next`, its attempt bump. The stamp is the `seq`, which `holdFor` writes with each rewrite, so the stored format did not change. A rewrite in this tab shows in `current` at once, before its write lands, as an object other than `next`. The key may belong to another tab, whose kept entry this tab is replaying. That tab's rewrite shows only in storage, so the check also reads the entry back and compares its `seq` with `next`'s. A changed entry stays. The same check guards the replay's final failure: the queue gives up on the replayed variables, and the entry stays for the run that rewrote it. A pass that keeps an entry this way ends its group. The read back costs one `get` per replay that succeeds or gives up. The read and the delete are not one step, so a rewrite that lands between them is still lost.
- **A live owner's success.** Two screens save one document under one key. The second run collapses onto the first run's entry while the first is still sending, and `holdFor` does not run, because the owner's variables stand while it executes. The owner's success dropped the entry, and the rider went on with nothing on disk. The `'success'` branch of `onSettle` (`plugin.ts:1318-1335`) now asks `newestRider` for a run still riding on the entry with a higher `seq` than the one that succeeded. When there is one, `holdFor` gives the entry its variables and the entry stays. The rider's own settle then drops it or keeps it. A rider that succeeds is compared by its own `seq`, so an older rider's variables never replace a newer one that landed.

The live-owner case replaces the rule "an owner's success drops the entry, riders or not". A double submit under one key now keeps the entry until the second run settles. If that run fails, a replay sends its variables once more, and the server's idempotency key absorbs it. That is at-least-once, as everywhere else in the queue. Pinned by four tests in the "latest-wins + dedupeBy" group of `deliberate-cancel.test.ts`: a replay's success, a replay's final failure, another tab's replay, and a live owner's success. Three of them failed on the old code; the final-failure test guards a branch that the old code reached only through a success.

## A kept entry ends its group's pass (third 1.0 review)

A pass replays each group serially in `seq` order, but a failure worth a retry used to return normally, and the loop went on to the next entry. On disk `r1` holds draft v1 and `r2` draft v2. Draft v1 gets one 503, and the startup pass keeps v1 and sends v2. The next `replayNow()` sends v1. The server ended on the stale draft.

`replayEntry` now resolves `false` when the entry stays on disk ahead of the rest of its group, and the bucket loop (`plugin.ts:1135-1147`) stops there. The later entries wait for the next pass, and each is reported on the devtools lane as `waiting`. It resolves `false` for a failure worth a retry and for an abort. It resolves `false` for an entry a live run rides on, in this tab or another, and for one a collapse rewrote during its replay. It resolves `true` for a success, a final failure and every drop, since then nothing of the entry is left ahead of the others. A missing definition resolves `true` too: every entry of the group shares the id, so each reports `onReplayError` in turn and none runs. Other groups go on.

The cost: a group whose first entry keeps failing sends nothing after it until that entry succeeds or is dropped at `maxAttempts`. A live run that hangs holds back the later entries of its id until a pass after it settles. No pass starts when a live run settles; the next reconnect, `replayNow()` or load does. Pinned by "a transient failure ends its group for the pass, and the next pass keeps the order" in `replay-order.test.ts`, which failed on the old code. Two older tests pinned the old overtaking, and they were rewritten. One is the throwing `onReplayAttempt` test in `coverage-lifecycle.test.ts`. The other is the failed-attempt lane test in `devtools-lane.test.ts`, which now puts its retryable entry last.

## Live runs in other tabs (third 1.0 review)

The in-flight check is per tab, and the replay lock covers replays only. Tab B runs `create('sku-1')` and its request hangs. Tab A calls `replayNow()`, lists B's entry and sends it, so the server sees `sku-1` twice. The idempotency key kept the effect single, but the queue sent a request a live tab had out.

Each live run now marks the entry it rides on as its tab's, from `record` until its settle, when no run of the tab rides on the entry any more. `marks` (`plugin.ts:342`) holds one mark per entry, and `markEntry` (`plugin.ts:347-388`) makes it:

- **With Web Locks**, a lock named `olas-mq-run:<entry key>` (`runMarkName`, `plugin.ts:1583-1585`), held until a promise the settle resolves. The request is not awaited, so the run's first request goes out without waiting for the grant.
- **Without Web Locks**, a `localStorage` lease under the same name, `<timestamp>:<tabId>`. One heartbeat per plugin refreshes every lease the tab holds each 15 seconds, and stops when the last one is released.
- **With neither**, as in Node and SSR, no mark: there is one context.

`markedElsewhere` (`plugin.ts:407-436`) runs in `replayEntry` right after the in-flight check. With Web Locks it asks for the entry's lock with `ifAvailable` and lets it go at once. Without, it reads the lease, and a lease from another tab younger than 30 seconds marks the entry. An older lease is removed, and the entry replays. `leaseIsFresh` also rejects a timestamp more than 30 seconds in the future, which only planted storage holds; the replay lease uses it too (R5 in `../decisions/trust-model.md`). A marked entry is skipped as `in-other-tab`, and its group waits. A lock or lease that cannot be read counts as no mark, as a replay lease that cannot be read does.

A dead tab's entries replay. The browser releases a closed document's locks, a lease with no heartbeat expires, and `dispose()` releases every mark, since the root aborts the tab's runs and their entries stay. Web Locks was chosen over writing an owner into the entry because it needs no stored-format change and no rewrite on settle.

The guarantee, precisely: a replay pass does not send an entry while a run in another live tab rides on it and holds its mark. Two windows stay open. A Web Lock is granted a moment after `record` requests it, and the entry is written in that moment, so a replay that lists the entry then sends it too. And a run that starts riding on an entry after another tab's replay began sending it goes out as well, since the replay checked before it started. Delivery stays at-least-once, and the server's idempotency key stays the gate. Pinned by the "a run live in another tab" group in `coverage-replay-lock.test.ts`. Web Locks and the lease each hold a replay back. A closed tab, an expired lease and a lease dated in the future each let it through. A heartbeat keeps a long run's lease fresh, and a settle leaves a lease another tab took over. A lock manager that refuses the marks degrades to an uncoordinated replay. The two hold-back tests failed on the old code. On Node 26, `navigator.locks` exists, so every test root takes these locks; Node 22 has none, and CI runs on it.

## Replay

Three triggers funnel into `runReplay` (`plugin.ts:1161-1171`), which a `replaying` flag keeps from overlapping and `withReplayLock` keeps from overlapping across tabs:

- **Startup.** `setup` starts a pass, `startup = runReplay()` (`plugin.ts:1182-1183`). It is `host.track`ed when the tab starts online, so `root.waitForIdle()` waits for it. An offline pass parks until reconnect, and tracking it would hold `waitForIdle` for that long.
- **Reconnect.** `host.network.onReconnect` starts a pass (`plugin.ts:1174-1176`), so in-session failures retry when the network returns. The host removes the subscription when the plugin disposes.
- **On demand.** `MutationQueue`'s `replayNow()` (`plugin.ts:1177`).

`replayAll` (`plugin.ts:1071-1154`) lists the entries under the prefix, drops the ones past `ttlMs`, waits for `host.network.isOnline()`, and groups the rest by mutation id. Each group runs in `compareEntries` order (`plugin.ts:1493-1497`), serially, and different ids run in parallel. An entry that stays on disk ends its group's pass; see "A kept entry ends its group's pass" below. `replayEntry` (`plugin.ts:774-973`) then:

1. skips an entry a live run in another tab has marked (`markedElsewhere`);
2. reads the definition through `host.mutations.get(id)`. A missing one reports `onReplayError` and leaves the entry for a later load;
3. drops an entry whose definition lacks `meta.persist: true`, or one already at `maxAttempts`;
4. writes the entry back with `attempts + 1` before running, so a crash mid-run cannot loop on it;
5. runs it with `host.mutations.run(id, variables)`, the core runner. The definition's `retry` applies, `mutate` receives the root's `deps`, the run counts toward `waitForIdle`, and devtools reports it under the path `['plugin', 'olas-mutation-queue']` (`packages/core/src/query/client.ts:1129-1140`). Its events carry the plugin's name, so `onMutation` does not persist the replay a second time.
6. on success, drops the entry, unless a collapse rewrote it meanwhile, and calls `onReplaySettle(entry, result, queries)`. A throw from that handler goes to `onWarn`.
7. on failure (`plugin.ts:923-971`), drops and reports when the attempt was the last one allowed or `isRetryable`, called through `retryable`, rejects the failure. Otherwise it calls `onReplayAttempt`. An abort, or the plugin disposing mid-run, counts as no attempt.

`onReplaySettle` receives the root's `QueryHost`, so a reconciliation invalidates in this root only. It addresses entries by query id and **`key(...)` output**, as every `QueryHost` method does: `queries.invalidate('orders/list', [])`. Pinned by "onReplaySettle fires with the result and the root query host after a successful replay", which also checks that a second live root does not refetch.

## Failures a retry cannot fix (`isRetryable`, 1.0)

Before 1.0 the queue treated every failure as transient. A 422, 400 or 409 fails the same way on every load, so it burned every `maxAttempts`, over several page loads with `backoffMs` set, before `onReplayError` fired.

`isRetryable(err, entry)` is the consumer's answer, because `mutate` is the consumer's function and the queue cannot read a status code without being handed one. The README's example throws an `HttpError` carrying the status and reads it in the predicate. The predicate runs through `retryable` (`plugin.ts:494-502`), which returns `true` without the option and turns a throw into an `onWarn` plus `true`, so a buggy predicate keeps today's behavior.

- **Where it is asked.** A live run's `'error'` settle (`plugin.ts:1336-1378`) and a replay's failure (`plugin.ts:923-971`). A `false` on a live run drops the entry at once, so a 422 on the first request leaves nothing for the next load.
- **Where it is not.** The last allowed attempt is final whatever the predicate says, and `replayEntry` does not ask about it. An abort is not a failure, so it is not asked either.
- **What it reports.** `onReplayError(err, entry)` with the error `mutate` threw, and no `onReplayAttempt`.

Pinned by `tests/retryable.test.ts`: the replay and live paths, the kept-on-retryable path, the last-attempt rule, and the throwing predicate.

## Replay order within a mutation id (1.0)

`compareEntries` sorts by `seq`, falling back to `enqueuedAt` for an entry from before `seq` existed, then by `runId` (`plugin.ts:1482-1497`).

`seq` comes from `seqCounter`, seeded from `Date.now()` in `setup` (`plugin.ts:260`). Two tabs that open in the same millisecond therefore mint the same `seq` for unrelated entries. Before 1.0 the sort stopped at `seq`, so a tie kept whatever order `keys()` listed. IndexedDB's `getAllKeys` returns sorted keys, which happened to order a tie by `runId`; `localStorage` key order is up to the browser, and it can differ between tabs. The `runId` tie-break gives every tab one total order: runIds are random per run, and the storage key makes each one unique within a mutation id. They are compared by code unit, not `localeCompare`, so two tabs with different locales agree.

A new `tabId` field was the other option. It was not taken, because every entry of every version already carries a `runId`. A `tabId` would have changed the stored format, and entries from 0.8 would still have tied among themselves. Within one tab `seq` is strictly increasing, so a tab's own entries keep the order it wrote them either way.

Pinned by `tests/replay-order.test.ts`: two tabs frozen on one `Date.now()` replay in one order whatever order the adapter lists keys in, and entries with and without `seq` still replay.

## Cross-tab coordination and reconnect (T6.2)

- **Replay on reconnect, not only on reload.** See the triggers above. Pinned by "replay waits for offline, then fires on the online event" and "replayNow() re-drives a pending entry in-session".
- **One tab replays at a time** (`withReplayLock`, `plugin.ts:1029-1059`). It prefers Web Locks, through `navigator.locks.request(name, { ifAvailable: true }, …)`. A tab that cannot get the lock skips the pass, and the holder replays every entry under the shared prefix. Without Web Locks it falls back to a TTL'd `localStorage` lease with a heartbeat (`acquireLease`, `releaseLease`, `plugin.ts:1606-1640`). Node and SSR have neither, so they run uncoordinated. This is **best-effort, not exactly-once**: the lease leaves a double-replay window, and the server's idempotency key is the real gate. Pinned by `coverage-replay-lock.test.ts`.
- **A replay skips another tab's live runs** (third 1.0 review). The lock covers replays only; see "Live runs in other tabs" below.
- **A lease from the future is no lease** (third 1.0 review). `acquireLease` counted any timestamp not older than the TTL as fresh, so a lease dated ahead held the replay lock for good. `leaseIsFresh` takes a timestamp within the TTL of now in either direction.
- **Cache reconciliation** is `onReplaySettle`, above. Without it, subscribers show stale data until their `staleTime` lapses.

## Other honesty fixes (T6.2 and after)

- **`seq` is seeded from `Date.now()` in `setup`**, as `let seqCounter = Date.now()` (`plugin.ts:260`). An enqueue that races the startup pass therefore still sorts after entries from the previous session. `replayAll` also raises the counter to the highest `seq` on disk. A same-millisecond tie between two tabs is left to the `runId` tie-break above.
- **`activeKeys` clears only when the entry drops.** Every drop goes through `dropEntry`: a success, an error the queue gives up on, a supersede or reset, and every replay drop, TTL expiry included. `dropEntry` also clears the entry's `retained` record, and `deleteEntry` its `current` content. It stays on a cancel by dispose and on an error the queue keeps. Otherwise a re-enqueue after such a cancel would write a second durable entry for the same operation. Until 1.0 a replay deleted its entry without clearing the key. After an in-session failure was replayed, the key pointed at a `runId` that was gone. The next run with that key collapsed onto nothing, wrote no entry, and a reload lost it. Pinned by "a replay that drops an entry releases its dedupe key" in `plugin.test.ts`.
- **`dispose()` releases a pass parked on the offline wait.** `waitForOnline` registers its resolver in `onlineWaiters`, and `dispose()` trips every one (`plugin.ts:1450-1476`). The wait sits inside `withReplayLock`, so a tab that disposed while offline used to hold the cross-tab lock until a network that may never return. `dispose()` wakes the backoff sleepers the same way. Pinned by "dispose() drops every online listener, including the parked replay pass" and `backoff-dispose.test.ts`.
- **A delete waits for the write it follows.** `pendingWrites` holds each in-flight write by `runId`, and `deleteEntry` awaits it (`plugin.ts:556-574`). A run that settles before its write lands therefore leaves no phantom entry. See the next section for what exercises it.

## The write ordering on an async storage (1.0)

An async store such as IndexedDB gives no order between two requests in flight at once. A `delete` issued while its entry's `write` is pending can land first, and the write then leaves an entry for a run that already settled. `pendingWrites` stops that by issuing the delete only after the write resolves.

In a real root the window is narrow, because `wrapMutate` awaits the write before `next()`. One path reaches it: a `dedupeBy` collapse. The collapsed run writes nothing and goes out at once, and its success deletes the owner's entry while the owner's write may still be pending. If the owner then fails, an overtaken delete leaves its entry on disk, and the next load sends the write a third time.

`tests/async-storage-order.test.ts` pins it with a fake storage whose `set` and `delete` stay pending until the test lands them, newest first. It covers a direct settle during a pending write, a drop at `maxAttempts`, and the collapse path through a real root. With the guard removed, all three fail on `expected [ 'set', 'delete' ] to deeply equal [ 'set' ]`. Two older `coverage-lifecycle.test.ts` tests, with an async `set` and a sync `delete`, fail too. So the guard had coverage before 1.0, which the BACKLOG entry that asked for this test did not know.

## The devtools lane (1.0)

In its development build the plugin publishes on its lane through `host.debug`. Each call sits inside `if (__DEV__)` with the payload built inline, so the default build drops the call and the object literal. `LaneEvent` (`plugin.ts:1505-1536`) is the payload union:

- `replay:attempt`, after the bumped count is on disk, with `attempt`;
- `replay:result`, with `attempt`, `result` (`success`, `retry-later`, `max-attempts`, `not-retryable` or `aborted`) and the `error` on a failure;
- `replay:skipped`, for an entry a pass leaves without an attempt, with `reason` (`in-flight`, `in-other-tab`, `waiting`, `not-registered`, `not-persisted`, `max-attempts` or `ttl-expired`). `in-other-tab` is an entry a live run in another tab marked, and `waiting` is each entry a group leaves behind a kept one.

Every payload carries `mutationId` and `runId`, and none carries the variables, so an event costs one small object. `LaneEvent` is not exported: the shape serves the panel, and the README says a minor release can change it. An `aborted` result from the root disposing does not reach the panel: the root calls `plugins.close()` before it disposes anything (`packages/core/src/plugin/host.ts:221-224`), and a closed host drops `debug` calls (`host.ts:166-167`). Only a `mutate` that rejects with its own `AbortError` shows one.

Using `__DEV__` gave the package its first dev-only code, so it now ships the two builds the other dev-code packages ship (`tsdown.config.ts`, `src/__dev__.d.ts`) and a `development` export condition. See `../decisions/esm-only-build.md`. Pinned by `tests/devtools-lane.test.ts`.

## Option surface

`plugin.test.ts`, `coverage-lifecycle.test.ts` and `retryable.test.ts` cover the options:
- `dedupeBy` collapses on an idempotency key;
- `isRetryable` drops an entry on a failure no retry can fix;
- `ttlMs` drops expired entries and reports `ttl-expired` through `onReplayError`;
- `backoffMs` and `maxBackoffMs` give exponential backoff across loads;
- `onReplayAttempt` fires on a failure the queue keeps the entry for;
- `migrate` ports an entry from an earlier `PROTOCOL_VERSION`;
- `maxEntryBytes` is a soft cap reported through `onWarn`.

The online gate and `seq` ordering are covered too. The unit tests drive `onMutation` and `wrapMutate` through a `directHooks` fake host (`plugin.test.ts:57-122`). Replay tests wait with `root.waitForIdle()`, since the startup pass is tracked.

## Limitations

The queue does not order runs across mutation ids. Different ids replay in parallel, and tabs do not coordinate order. Model dependent steps under one mutation id, or make the server tolerate any order. Tracked in `BACKLOG.md`.

A live run can collapse onto an entry while a replay of that entry is out. It goes to the server beside the replay, and the two can land in either order. `BACKLOG.md` tracks it.

Within one id, entries from two tabs interleave by `seq`, which each tab seeds from its own start time. That order tracks when each tab opened, not when each entry was enqueued, so it is a stable order and not a causal one.

## Replaying stored entries safely (1.0)

Storage is state other same-origin code can write, so replay checks it:
- **Only opted-in mutations run.** `replayEntry` reads the definition through `host.mutations.get(id)` and drops an entry whose definition lacks `meta.persist: true` (`plugin.ts:830-851`).
- **The key must match the contents.** `listEntries` drops an entry stored under a key other than `entryKey(mutationId, runId)` (`plugin.ts:713-763`). Every later write and delete goes by that key, so a mismatched entry was never removed and replayed on every load. A migrated entry is rewritten under its new key and its old key deleted, so a `migrate` that renames the mutation runs once.
- **Every field is checked** by `isValidEntry` (`plugin.ts:662-679`): a whole, non-negative `attempts`, a finite `seq`, and an `enqueuedAt` at most `CLOCK_SKEW_MS`, five minutes, ahead. Migrated entries go through the same check.

Pinned by `tests/security.test.ts`; the review is `../decisions/trust-model.md`.
