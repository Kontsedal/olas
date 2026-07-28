---
name: devtools-causal-timeline
description: "End-to-end flow of the devtools causal timeline: how a mutation's events get one causeId in core, and how the panel folds them into a cause-chain with a before/after diff."
type: flow
covers:
  - packages/core/src/devtools.ts
  - packages/core/src/query/mutation.ts:302-441
  - packages/core/src/query/client.ts:98-140
  - packages/devtools/src/store.ts
  - packages/devtools/src/DevtoolsPanel.tsx
  - packages/devtools/src/diff.ts
edges:
  - { type: uses, target: ../modules/devtools.md }
  - { type: uses, target: ../modules/devtools-panel.md }
  - { type: related, target: mutation-concurrency.md }
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-07-28
confidence: medium
---

# Flow: the devtools causal timeline

How one user action becomes a single, collapsible cause-chain in the panel — with a
structural before/after diff on each cache write. Spec §14 (Timeline overhaul T8.1 + T8.4).

## The worked example

An optimistic mutation whose `mutate` fails and rolls back:

```ts
save: ctx.mutation({
  name: 'save',
  mutate: async () => { throw new Error('boom') },
  onMutate: () => q.setData('1', () => 'optimistic'), // server was 'server-1'
  retry: 0,
})
```

## 1. Core mints one `causeId` for the run

`MutationImpl.executeRun` mints `runId` up front (`mutation.ts`, near the top of
`executeRun`; `makeRunId()` runs when persistable OR `__DEV__`). It is the devtools
`causeId` for the whole run.

## 2. The ambient cause threads it into triggered writes

The problem: the optimistic `cache:set-data` and the `snapshot:*` events happen deep
inside user code (`onMutate` → `q.setData` → `client.setData` → `Entry.setData`), which
has no idea a mutation is running. Rather than thread `runId` through every signature,
core sets a **dev-only ambient cause**:

- `MutationImpl` wraps `onMutate` in `__runWithCause(runId, () => onMutate())` and wraps
  the snapshot's `rollback`/`finalize` bodies the same way (`mutation.ts` `wrapSnapshot`).
- The QueryClient's devtools emit closures — `emitDevtoolsSetData` and the
  `onSnapshotPush/Rollback/Finalize` hooks in the `ClientEntry` `EntryEvents` bundle
  (`client.ts:98-140`) — read `__currentCauseId()` **at emit time**.

Because `onMutate` and the rollback run synchronously on the stack while the ambient is
active, every write they trigger inherits `runId`. Outside dev the helper is a plain
passthrough (zero cost). See [../modules/devtools.md](../modules/devtools.md) →
"Correlation backbone".

## 3. The emitted chain (all sharing `causeId = runId`)

```
mutation:run          causeId=R   (name 'save')
snapshot:push         causeId=R   (queryKey ['1'])
cache:set-data        causeId=R   source 'mutate'  data 'optimistic'
snapshot:rollback     causeId=R   (mutate threw → auto-rollback)
cache:set-data        causeId=R   source 'mutate'  data 'server-1'   (rollback re-broadcast)
mutation:rollback     causeId=R
mutation:error        causeId=R
```

Each event is `seq`/`t`-stamped by `DevtoolsEmitter.emit` (`stamp`, `devtools.ts`). A
successful run instead ends `snapshot:finalize` + `mutation:success`.

## 4. The store builds the timeline

`DevtoolsStore.handle` calls `pushTimeline(event)` for EVERY event (`store.ts`): it
appends a `TimelineEvent { id, seq, t, causeId?, event, prev? }` to the bounded
`events$`. For a `cache:set-data` it records `prev` = the last-seen data for that key
(`lastDataByKey`, seeded on `attach()` from `queryEntries()`) BEFORE advancing the
baseline — this is the diff's "before". Cache/snapshot events also flip
`cacheStateDirty`, so `flushPending` refreshes `cacheState$` from `queryEntries()` (the
event-driven inspector — no poll).

## 5. The panel folds it into a cause-chain + diff

`TimelineView` → `groupByCause` collapses all events with one `causeId` into a single
`<CauseGroup>` (`DevtoolsPanel.tsx`), colored by worst outcome (this run → red, it
errored), with `+Δms` deltas from the group start. The two `cache:set-data` rows expand
to `<DiffView>`, which runs `diffValues(prev, data)` from `diff.ts` — the first shows
`'server-1' → 'optimistic'`, the rollback shows `'optimistic' → 'server-1'`.

Net: the entire optimistic-apply → fail → rollback story is one readable, timestamped
group instead of seven scattered log lines — the correlation Olas can do because one bus
spans mutations, the cache, and the snapshot stack. This is the acceptance scenario in
`candidates/decisions/devtools-overhaul.md` (T8.4), verified by
`packages/devtools/tests/panel.test.tsx` and `packages/core/tests/devtools-events.test.ts`.
