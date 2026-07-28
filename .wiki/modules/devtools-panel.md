---
name: devtools-panel
description: "@kontsedal/olas-devtools — in-app DevtoolsPanel over root.__debug. Causal Timeline (cause-chains + structural diffs), tree, cache log, event-driven inspector, mutations, fields."
type: module
covers:
  - packages/devtools/src/index.ts
  - packages/devtools/src/DevtoolsPanel.tsx
  - packages/devtools/src/DevtoolsLauncher.tsx
  - packages/devtools/src/JsonView.tsx
  - packages/devtools/src/diff.ts
  - packages/devtools/src/store.ts
  - packages/devtools/src/format.ts
  - packages/devtools/src/styles.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/devtools/tests/store.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/panel.test.tsx }
  - { type: tested-by, target: ../../packages/devtools/tests/diff.test.ts }
  - { type: uses, target: devtools.md }
  - { type: uses, target: react.md }
  - { type: related, target: ../flows/devtools-causal-timeline.md }
  - { type: related, target: ../pitfalls/raf-unbound-illegal-invocation.md }
last_verified: 2026-07-28
confidence: medium
---

# `@kontsedal/olas-devtools`

Drop-in React panel that subscribes to a root's `__debug` bus and renders six live views. The **default / headline view is the causal Timeline** — every event ordered by `seq` and grouped by `causeId` into collapsible cause-chains, each `cache:set-data` expandable to a structural before/after diff. The other tabs are controller Tree, Cache (event log), Inspector (live cache state), Mutations, and Fields. Plus a floating `<DevtoolsLauncher>` that hosts the panel inside a draggable / resizable window with state persisted to `localStorage`. Spec §13/§14.

## Public surface

```ts
type DevtoolsTab = 'timeline' | 'tree' | 'cache' | 'inspector' | 'mutations' | 'fields'

function DevtoolsPanel(props: {
  root: Pick<Root<unknown>, '__debug'>
  defaultTab?: DevtoolsTab // default 'timeline'
  maxEntries?: number
  urlHashKey?: string
  inspectorPollMs?: number // deprecated + ignored — the inspector is event-driven now
}): JSX.Element

function DevtoolsLauncher(props: {
  root: Pick<Root<unknown>, '__debug'>
  defaultTab?: DevtoolsTab
  maxEntries?: number
  urlHashKey?: string
  storageKey?: string
  initial?: { x?: number; y?: number; w?: number; h?: number }
}): JSX.Element

class DevtoolsStore {
  tree$: Signal<ControllerNode>          // live controller tree (not a log)
  cache$: Signal<CacheEntry[]>           // cache event log (bounded)
  mutations$: Signal<MutationEntry[]>    // mutation event log (bounded)
  fields$: Signal<FieldEntry[]>          // field-validation log (bounded)
  events$: Signal<TimelineEvent[]>       // unified timeline — EVERY event (bounded by maxTimelineEntries)
  cacheState$: Signal<DebugCacheEntry[]> // live cache state (event-driven, no poll)

  attach(root): () => void
  handle(event: DebugEvent): void
  clearLogs(): void   // clears logs + timeline; keeps tree + cacheState
}

// TimelineEvent = { id, seq, t, causeId?, event: DebugEvent, prev? }
// `prev` is the pre-write value for a cache:set-data (the diff baseline).

function insertNode(root, path, props): ControllerNode
function setNodeState(root, path, state): ControllerNode
function formatPath(path): string
function formatPayload(value, maxLen?): string
function formatTime(t: number): string
```

## Architecture

The package splits into three pieces:

1. **`store.ts`** — pure logic. A `DevtoolsStore` exposes four `Signal`s (one per view). `handle(event)` is the dispatcher; it routes a `DebugEvent` to either `tree$.set(insertNode(...))` / `tree$.set(setNodeState(...))` or one of the bounded-log pushers. Tested in isolation; no React.
2. **`DevtoolsPanel.tsx`** — React component. `useMemo(() => new DevtoolsStore(...), [maxEntries])`, then `useEffect(() => store.attach(root), [root, store])`. Tabs are local React state. Each view reads its signal via `@kontsedal/olas-react`'s `use()` and renders.
3. **`format.ts` / `styles.ts`** — tiny helpers. `styles.ts` is a hard-coded CSS string injected via `<style>` inside the panel — no build-time CSS extraction needed.

## Why the tree has a virtual empty root

`DevtoolsStore.tree$` starts as `{ path: [], state: 'active', children: [] }`. The first `controller:constructed` event has path `['root']`, which becomes a child of the virtual node. This keeps `insertNode` purely recursive — no special case for "the first node is the root". The panel renders `tree.children`, treating the wrapper as invisible.

## Bounded logs

`cache$` / `mutations$` / `fields$` are capped at `maxEntries` (default 100). When full, the oldest entry drops (via `appendBounded` — `slice` + `push`). Each entry has an auto-incrementing `id` for React `key`s and a `t` (ms epoch) for display.

`tree$` is NOT a log — it's the live state of the controller tree. `clearLogs()` empties the three log signals but preserves the tree.

## T6.3 hardening

- **Bounded tree.** Disposed controllers used to accumulate in `tree$` forever (churny virtualized lists / lazy children). `pruneDisposed()` (called on `controller:disposed`) removes the oldest **fully-disposed subtrees** once the retained-disposed count exceeds `maxDisposedNodes` (option, default `DEFAULT_MAX_DISPOSED_NODES = 200`). Active/suspended nodes — and any disposed node with a live descendant — are never pruned (`subtreeAllDisposed` guard). Pure helpers `countDisposed` / `collectPrunableRoots` / `removeNodeAt` are exported and unit-tested.
- **Concurrent mutation durations.** `mutationStarts` is now `Map<path#name, number[]>` — a FIFO queue of `run` start times. Overlapping runs of the same mutation each pair (oldest-first) with their own duration; the old single-value map let a later run's start clobber the earlier one's, losing a duration. Exact run↔settle attribution isn't possible (the debug bus carries no per-run id), but FIFO never loses a start.
- **`JsonView` cycle guard.** `seen` is the set of **ancestors on the current path**, rebuilt immutably per level (`new Set(seen).add(value)`), not a mutated shared set of everything-rendered. A shared reference (`{a: obj, b: obj}` — a DAG) is no longer mis-flagged `[Circular]`, collapse→re-expand doesn't carry stale state, and StrictMode's double-render stays independent. True cycles (a node that is its own ancestor) are still caught. Tested in `jsonview.test.tsx`.
- **Debounced filter.** The panel's filter `<input>` stays responsive (`value={filter}`), but views filter against a 150ms-debounced `debouncedFilter`, so a `JSON.stringify`-per-entry pass doesn't run on every keystroke.

## Post-mount observability

Spec §13 phrasing: "Without devtools, large signal graphs become opaque." This panel subscribes via `useEffect` on mount, so the *initial* `controller:constructed` for the root happens before subscription — the tree starts empty even though the root exists. Mount the panel as early as possible in the React tree to maximize what's captured.

For full history, build a `DevtoolsStore` next to `createRoot` (before any controller exists) and pass it to a custom UI later. The store and the panel are decoupled — the panel uses one internally; consumers can use the store on its own.

## DistributiveOmit

`store.ts` defines a small `DistributiveOmit<T, K>` helper because the default `Omit<UnionType, K>` collapses to the intersection of common keys — losing per-variant fields. Used in the `pushCache` / `pushMutation` parameter types so a call site can supply just one variant's payload.

## The six tabs

| Tab | Reads | Renders |
|-----|-------|---------|
| **Timeline** (default) | `store.events$` | Cause-chains: events grouped by `causeId` into collapsible `<CauseGroup>`s (accent-colored by worst outcome); un-caused events standalone. Newest-first; within a group chronological with `+Δms` from group start. Each `cache:set-data` expands to a `<DiffView>`; other payload-carrying events expand to `<JsonView>`. |
| **Tree** | `store.tree$` | Recursive `<TreeNode>`; struck-through for `disposed`, orange for `suspended`. |
| **Cache** | `store.cache$` | Event log `<ul>`: time · kind · `formatPath(queryKey) + details`. Red for `fetch-error`. |
| **Inspector** | `store.cacheState$` | Live cache state (data / status / stale / fetching / optimistic tags), refreshed from `queryEntries()` on cache events — **no polling**. |
| **Mutations** | `store.mutations$` | time · kind · `formatPath(path) + payload`. Red for `error`, orange for `rollback`. |
| **Fields** | `store.fields$` | Time · `valid`/`invalid` · path · field · errors. |

## The causal Timeline (T8.4)

`store.events$` is a bounded, `seq`-ordered log of EVERY event (bound = `maxTimelineEntries`, default 500 — higher than the per-view `maxEntries` because it aggregates all families). `groupByCause` folds it into rows: events sharing a `causeId` collapse into one `<CauseGroup>` positioned at the group's first event (the group array is filled by reference as later events arrive, so a whole mutation chain renders together); un-caused events stay standalone. Rows render newest-first; a group's inner events stay chronological so cause → effect reads top-down.

A `cache:set-data` row expands to `<DiffView>`, which renders `diffValues(entry.prev, event.data)` from `diff.ts` — a small, cycle-safe AND depth-bounded (`MAX_DIFF_DEPTH`, so an arbitrarily deep cache value can't overflow the stack and crash the panel) structural walker (added/removed/changed keys highlighted; wholly-unchanged subtrees collapse to a `same` node and are summarized as "+N unchanged"). `diff.ts` deliberately does NOT import core's structural-share internals. The store seeds the per-key diff baseline (`lastDataByKey`) on attach and evicts it on `cache:gc`, so a re-fetch after GC reads as an initial write, not a diff against a ghost value.

## Event-driven inspector (the poll is gone)

The Inspector previously polled `root.__debug.queryEntries()` on a `setInterval` (default 800ms). Now the store seeds `cacheState$` from `queryEntries()` ONCE on `attach()` and refreshes it — coalesced through the same flush as the logs — whenever a cache / snapshot event arrives. No interval. `attach()` also seeds the per-key **diff baseline** (`lastDataByKey`) from that first snapshot, so the first post-attach write to an already-cached key diffs against real data rather than reading as "initial". The `inspectorPollMs` prop is retained but ignored (deprecated). Caveat: a pure timer-driven `isStale` transition (no accompanying event) won't refresh the inspector until the next event — the accepted tradeoff for killing the poll.

## What's tested

- `store.test.ts` (25 tests) — `insertNode` / `setNodeState`, bounded logs, `DebugEvent` variants through `handle()`, `attach()` unsubscribe, PLUS the unified timeline (ordering, `seq` fallback vs emitter `seq`, `causeId`, `prev` diff baseline + seed-on-attach, `maxTimelineEntries` bounding, pause-drops, clear-resets-baseline) and the event-driven `cacheState$` (seed on attach + refresh-on-cache-event + no-refresh-on-non-cache-event).
- `diff.test.ts` (10 tests) — `diffValues` add/remove/change/same, nested recursion, DAG-vs-cycle, opaque built-ins (Date), first-write.
- `panel.test.tsx` (10 tests) — RTL: default Timeline tab, cause-chain grouping of a failing optimistic mutation, `cache:set-data` diff expansion, event-driven inspector; plus prior tree / cache / clear / tabs / suspend / debounce / defaultTab coverage.
- Indirectly: `core/tests/devtools-events.test.ts` pins the runtime-emit + `seq`/`causeId` correlation contract.

## What's NOT included / follow-ups

- **`cache:subscribed`** wiring (subscriber counts) — needs subscriber-path threading through `use → acquire` (overhaul T8.5). Declared in the union, not emitted.
- **Infinite-query** fetch / snapshot devtools events — T8.1 wired regular queries only (`setInfiniteData` does emit `cache:set-data`).
- The rest of the devtools overhaul: virtualization + ring buffer (T8.2), omnibox search (T8.3), live actions (T8.6), env simulation + forms inspector (T8.7), plugin lanes (T8.8), session export/import (T8.9). See `../candidates/decisions/devtools-overhaul.md`.
- Signal dependency graph view (spec §13 mentions it).