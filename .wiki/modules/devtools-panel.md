---
name: devtools-panel
description: "@kontsedal/olas-devtools — in-app DevtoolsPanel over root.debug. Omnibox search, causal Timeline in a ring buffer with plugin lanes, windowed tree and logs, event-driven inspector."
type: module
covers:
  - packages/devtools/src/index.ts
  - packages/devtools/src/DevtoolsPanel.tsx
  - packages/devtools/src/DevtoolsLauncher.tsx
  - packages/devtools/src/JsonView.tsx
  - packages/devtools/src/diff.ts
  - packages/devtools/src/store.ts
  - packages/devtools/src/search.ts
  - packages/devtools/src/virtual.tsx
  - packages/devtools/src/Omnibox.tsx
  - packages/devtools/src/events.ts
  - packages/devtools/src/util.ts
  - packages/devtools/src/format.ts
  - packages/devtools/src/styles.ts
  - packages/devtools/scripts/minify-css.ts
  - packages/devtools/tsdown.config.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/devtools/tests/store.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/store-foundation.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/store-stress.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/panel.test.tsx }
  - { type: tested-by, target: ../../packages/devtools/tests/panel-foundation.test.tsx }
  - { type: tested-by, target: ../../packages/devtools/tests/virtual.test.tsx }
  - { type: tested-by, target: ../../packages/devtools/tests/url-hash-hostile.test.tsx }
  - { type: tested-by, target: ../../packages/devtools/tests/diff.test.ts }
  - { type: uses, target: devtools.md }
  - { type: uses, target: react.md }
  - { type: related, target: ../decisions/devtools-overhaul.md }
  - { type: related, target: ../flows/devtools-causal-timeline.md }
  - { type: related, target: ../pitfalls/raf-unbound-illegal-invocation.md }
  - { type: related, target: ../decisions/ui-rules.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-devtools`

Drop-in React panel that subscribes to a root's `debug` bus and renders six live views under one search box. The **default and headline view is the causal Timeline**. Every event is ordered by `seq` and grouped by `causeId` into collapsible cause-chains, and each `cache:set-data` expands to a structural before-and-after diff. The other tabs are the controller Tree, the Cache event log, the Inspector for live cache state, Mutations and Fields. Every long view is windowed, so it mounts only the rows in its viewport. A floating `<DevtoolsLauncher>` hosts the panel inside a draggable, resizable window, with state persisted to `localStorage`. Spec §14. The overhaul this implements is [../decisions/devtools-overhaul.md](../decisions/devtools-overhaul.md).

## Public surface

```ts nocheck
type DevtoolsTab = 'timeline' | 'tree' | 'cache' | 'inspector' | 'mutations' | 'fields'

function DevtoolsPanel(props: {
  root: Pick<Root<unknown>, 'debug'>
  defaultTab?: DevtoolsTab    // default 'timeline'
  maxEntries?: number         // per-log cap, default 100
  maxTimelineEntries?: number // timeline ring capacity, default 10,000
  urlHashKey?: string
}): ReactElement

function DevtoolsLauncher(props: {
  root: Pick<Root<unknown>, 'debug'>
  defaultTab?: DevtoolsTab
  maxEntries?: number
  maxTimelineEntries?: number
  urlHashKey?: string
  storageKey?: string
  initial?: { x?: number; y?: number; w?: number; h?: number }
}): ReactElement

class DevtoolsStore {
  readonly tree$: ReadSignal<ControllerNode>          // live controller tree (not a log)
  readonly cache$: ReadSignal<CacheEntry[]>           // cache event log (ring, maxEntries)
  readonly mutations$: ReadSignal<MutationEntry[]>    // mutation event log (ring)
  // MutationEntry.mutationId is the mutation's own id (event.id); MutationEntry.id numbers the entry
  readonly fields$: ReadSignal<FieldEntry[]>          // field-validation log (ring)
  readonly events$: ReadSignal<TimelineEvent[]>       // unified timeline (ring, maxTimelineEntries)
  readonly droppedEvents$: ReadSignal<number>         // timeline events the ring overwrote
  readonly cacheState$: Signal<DebugCacheEntry[]>     // live cache state (event-driven)
  readonly maxTimelineEntries: number

  attach(root): () => void
  handle(event: DebugEvent): void
  clearLogs(): void   // clears logs + timeline + dropped count; keeps tree + cacheState
  search(query: string, limitPerKind?: number): SearchGroup[]
  searchStats(): { builds: number; indexed: number }
}

// ControllerNode = { path, state, props, children, debug?, disposedAt? }
// TimelineEvent  = { id, seq, t, causeId?, event: DebugEvent, prev? }

function insertNode(root, path, props, debug?): ControllerNode   // pure, immutable
function setNodeState(root, path, state): ControllerNode
function setNodeDebug(root, path, debug): ControllerNode
function formatPath(path): string
function formatPayload(value, maxLen?): string
function formatTime(t: number): string
```

The log and tree signals became `ReadSignal`s in the 8A change. The store derives them from its rings and its keyed tree, so a caller has nothing to write.

## Architecture

1. **`store.ts`** — pure logic, no React. `handle(event)` routes each `DebugEvent` to the timeline ring, one of the three log rings and the keyed tree. Applying an event costs constant time plus the path depth, and nothing in `handle` scans the tree or a log.
2. **`DevtoolsPanel.tsx`** — the React component. It builds a `DevtoolsStore` with `coalesce: 'raf'`, attaches it in an effect, and reads each signal through `@kontsedal/olas-react`'s `useValue`.
3. **`virtual.tsx`** — `VirtualList`, the windowed renderer every long view uses, and `useToggles`, which keeps per-row open state outside the row.
4. **`search.ts` and `Omnibox.tsx`** — the lazily built search index and the search box over it.
5. **`events.ts` and `util.ts`** — per-event display helpers (badge, target, payload, lane), path and key hashing, the signal duck-type and `toSearchText`.
6. **`format.ts` and `styles.ts`** — `styles.ts` is a CSS string injected via `<style>` inside the panel, so a consumer has no stylesheet to import. Because of that it carries the shared type, corner, motion and colour scales **by value** rather than importing `examples/_shared/ui/tokens.css`; the duplication is deliberate and both files say so. Its tokens are declared on `.olas-devtools`, `.olas-devtools-launcher` and `.olas-devtools-floating` together, because the launcher and the floating window sit outside the panel in the DOM and inherit nothing from it. A host re-themes any of it through the `--olas-*` properties. See [../decisions/ui-rules.md](../decisions/ui-rules.md).

**The build minifies the stylesheet.** `tsdown.config.ts` runs `scripts/minify-css.ts` over the `DEVTOOLS_CSS` literal. The source keeps its comments, which carry the ui-rules reasoning, and the published bundle drops them. A JS minifier cannot reach inside a template literal, and the comments cost 1.4 KB brotli. `tests/minify-css.test.ts` checks that the minified sheet keeps every rule and class.

## The store's data structures (T8.2)

- **Rings.** The timeline and the three logs are each a `Ring` (`store.ts`). `add` buffers an item. The scheduled flush moves the buffer in, overwriting the oldest item once the ring is full, and bumps a version signal. The public signal is a `computed` over that version, so the array is copied only when someone reads it. `droppedEvents$` is the timeline ring's overwrite count. A paused store drops events before they reach a ring, so they are not counted.
- **The keyed tree.** Each controller is a mutable `Cell` in a `Map` by path key (`util.ts` `pathKey`), and each cell keeps its children in a `Map` by segment. A cell caches its immutable `ControllerNode` snapshot. A change clears the snapshot on the cell and its ancestors, stopping at the first one already cleared, and `tree$` rebuilds only those. The tree publishes once per event, at once, whatever `coalesce` says. The panel tests read the tree right after a lifecycle event inside one `act`, and they pin that.
- **Retained-but-capped disposed nodes.** Each cell counts the nodes and the live nodes in its subtree. A dispose queues the cell. Past `maxDisposedNodes`, the store pops the queue, skips a stale entry or a cell with a live descendant, and removes the largest fully-disposed subtree containing the popped cell. The order is dispose order; the old whole-tree walk used construction order. A compaction keeps the queue within about twice the disposed count, so churn on the same paths does not grow it.
- **Frozen disposal.** On `controller:disposed` the store replaces each signal in the node's `ctx.debug` record with the value it holds, and records `disposedAt`. A re-construction of a disposed path clears those frozen values unless the new event carries its own.
- **Mutation starts.** Pending `run` start times sit in a trie by controller path, then by mutation id, as FIFO queues. A settle pops the oldest start and prunes emptied trie nodes. A dispose drops the controller's subtree of the trie in O(depth). The earlier flat map was scanned on every dispose.

## Why the tree has a virtual empty root

The store's root cell has path `[]`. The first `controller:constructed` event has path `['root']`, which becomes a child of that cell. This keeps insertion uniform: no special case for "the first node is the root". The panel renders `tree.children`, treating the wrapper as invisible. `pruneDisposed` skips the virtual root, and `store-foundation.test.ts` pins that.

## Windowed rendering (T8.2)

`VirtualList` (`virtual.tsx`) takes a row count, a size estimate per row and a key per row. It prefix-sums the sizes into offsets and binary-searches the scroll position for the window, then mounts that window plus 8 rows of overscan. The container's top and bottom padding stands in for the rows it did not mount. After each render a layout effect measures every mounted row. A row's size is the distance to the next row's top, so margins count. A `ResizeObserver` re-measures rows that change size without a re-render, such as a `JsonView` toggle. jsdom lays nothing out, so there the list windows on estimates and a 600px fallback viewport.

Three consequences shape the views:

- **Row state lives outside the row.** A row that scrolls away unmounts, so the views keep open and expanded state in `useToggles`, keyed by row. A payload a user expanded is still expanded when the row scrolls back.
- **The Tree is flat.** `flattenTree` turns the tree into depth-first rows with `role="treeitem"` and `aria-level`. Per-level indent spans draw the old dashed nesting guides. A node with children has a collapse chevron.
- **A cause-group is one row.** An open group mounts 100 events and a "Show N more of M" button. Windowing inside a windowed row would cost more code than the page.

A jump asks the list to scroll a row a third of the way down the viewport. The first offset comes from estimates, so the list re-aligns for up to four renders while measurement moves the target.

## The omnibox (T8.3)

A combobox above the tabs, `Search everything`, searches the whole store through `store.search(query)`. `/` focuses it from anywhere in the panel; the panel root takes focus on a click for that reason. A `/` typed into a text field stays text. ArrowUp and ArrowDown move the active option, Enter picks it, and Escape closes the results and then clears the query.

`SearchIndex` (`search.ts`) builds five document lists: controllers, live queries, mutations, fields and event payloads. A query matches a document when every whitespace-separated term is a substring of its lowercased text. Results come back grouped in that order, up to 8 per group with the group's total.

- **Controllers** match on path, state, props and `ctx.debug` names.
- **Queries** match on the query id, the key as text and the entry's data or error. The store learns ids from the `queryId` on cache events.
- **Mutations** and **fields** are one document per path and name, pointing at their latest event.
- **Payloads** match an event's props, vars, result, error, data or plugin payload, and a plugin event's plugin name.

**Lazy and cached.** The store keeps a change counter. `search` rebuilds the index only when the counter moved since the last build. A rebuild reuses each item's text: events by object identity in a `WeakMap`, controllers and entries while their props, data and status are unchanged. So typing re-scans strings without re-stringifying a payload. `searchStats()` exposes the build and conversion counts, and the tests pin them. `toSearchText` renders a value as `key:value` tokens, cycle-safe, and stops at 2,000 characters.

**The jump.** Picking a result switches to its tab, clears that tab's filter and shows its lane if hidden. The target view then opens a collapsed ancestor or cause-group, pages a group far enough, scrolls, and outlines the row in the accent with `olas-devtools-hit`.

## Plugin lanes (T8.8, lanes only)

A plugin's `host.debug(payload)` reaches the bus as `plugin:event` with the plugin's name. The timeline badges those rows with the plugin name and shows the payload as the row's target. When at least one plugin lane exists, a toolbar above the timeline shows one chip per lane, `core` first, each with its event count. A chip is a toggle button: `aria-pressed="false"` hides the lane and strikes the chip. Hidden lanes are panel state, so they survive a tab switch.

## Bounded logs

`cache$`, `mutations$` and `fields$` are rings capped at `maxEntries` (default 100). The timeline ring holds `maxTimelineEntries` (default 10,000). Each log entry has an auto-incrementing `id` for React keys and a `t` (ms epoch) for display. `tree$` is not a log; `clearLogs()` empties the rings and the dropped count and preserves the tree.

## T6.3 hardening

- **Bounded tree.** See the retained-but-capped item above. T6.3 set the cap and its default, `DEFAULT_MAX_DISPOSED_NODES = 200`, and neither changed. The prune removes only subtrees whose live count is 0, so it skips active and suspended nodes and any disposed node with a live descendant.
- **Concurrent mutation durations.** Overlapping runs of the same mutation each pair, oldest first, with their own start. Exact run-to-settle attribution isn't possible, because the bus carries no per-run id on settle, but FIFO keeps every start.
- **`JsonView` cycle guard.** `seen` is the set of **ancestors on the current path**, rebuilt immutably per level. A shared reference is no longer mis-flagged `[Circular]`, and true cycles are still caught. Tested in `jsonview.test.tsx`.
- **Debounced filter.** The per-tab filter input stays responsive, and views filter against a 150ms-debounced value. Each entry's filter text is cached in a `WeakMap` the first time a filter runs over it, and it uses `toSearchText`, so a keystroke re-scans cached strings.

## URL-hash state (W15 L7)

With `urlHashKey`, the panel reads its tab and filters from the URL hash. `readUrlHash` validates the parsed JSON instead of trusting it. An unknown or non-string `tab` falls back to `defaultTab`, a non-string filter is dropped, and a value that is not a JSON object gives the defaults. Before, a crafted hash with a non-string filter reached `filter.trim()` during render, and with no error boundary React unmounted the host app. `url-hash-hostile.test.tsx` pins the fallbacks.

## Post-mount observability

The bus replays the live-controller snapshot to a new subscriber, so the Tree is complete on mount. Cache, mutation and field events from before the mount are not replayed. Mount the panel early to capture them, or build a `DevtoolsStore` next to `createRoot` and hand it to a custom UI later. `attach` flushes the replay at once, so the tree shows on the first render after mount.

## The six tabs

| Tab | Reads | Renders |
|-----|-------|---------|
| **Timeline** (default) | `store.events$` | Cause-chains: events grouped by `causeId` into collapsible `<CauseGroup>`s, accent-coloured by worst outcome; un-caused events standalone. Newest-first; within a group chronological with `+Δms`. Lane chips and the dropped count in a toolbar. |
| **Tree** | `store.tree$` | Flat, windowed tree rows with collapse chevrons. `suspended` in warn, `disposed` greyed with frozen variables. Each node shows its `ctx.debug` Variables (live) and props. |
| **Cache** | `store.cache$` | Event log: time · kind · `formatPath(queryKey)` and details. Red for `fetch-error`. |
| **Inspector** | `store.cacheState$` | Live cache state with stale, fetching and optimistic tags, refreshed from `queryEntries()` on cache events — no polling. |
| **Mutations** | `store.mutations$` | time · kind · `formatPath(path)` and payload. Red for `error`, warn for `rollback`. |
| **Fields** | `store.fields$` | Time · `valid` or `invalid` · path · field · errors. |

## The causal Timeline (T8.4)

`store.events$` is a `seq`-ordered ring of every event except `controller:debug`. `groupByCause` folds it into rows. Events sharing a `causeId` collapse into one `<CauseGroup>` at the group's first event. The group array fills by reference as later events arrive, so a whole mutation chain renders together. A group decides its default open state when the panel first sees it: open at 12 events or fewer. Rows render newest-first; a group's inner events stay chronological so cause → effect reads top-down.

A `cache:set-data` row expands to `<DiffView>`, which renders `diffValues(entry.prev, event.data)` from `diff.ts`. That is a small structural walker, both cycle-safe and depth-bounded by `MAX_DIFF_DEPTH`. It highlights added, removed and changed keys, and wholly-unchanged subtrees collapse to "+N unchanged". `diff.ts` deliberately does NOT import core's structural-share internals. The store seeds the per-key diff baseline (`lastDataByKey`) on attach and evicts it on `cache:gc`, so a re-fetch after GC reads as an initial write.

## Controller variables (`ctx.debug`)

A tree row whose `ControllerNode.debug` record is non-empty renders a **Variables** section, open by default, listing each `name: value` a controller registered via `ctx.debug({...})`. The store sets the record from `controller:constructed`'s `debug` field and updates it on `controller:debug`. `controller:debug` is kept off the timeline, because it is a state re-registration rather than a causal event.

Rendering is **reactive with no polling**. `<DebugVar>` duck-types a signal-like value (`util.ts` `isSignalLike`, `peek` plus `subscribeChanges`) and renders it through `<ReactiveValue>`, which calls `useValue()` (`DevtoolsPanel.tsx:600-601`). Non-signals render a static `JsonView`, and functions show `[fn]`. Only mounted rows hold subscriptions, so windowing also bounds the live subscriptions. A disposed node's values are frozen snapshots, so they render statically.

## Event-driven inspector (the poll is gone)

The store seeds `cacheState$` from `queryEntries()` once on `attach()` and refreshes it, coalesced through the same flush as the logs, whenever a cache or snapshot event arrives. `attach()` also seeds the per-entry diff baseline from that snapshot. **An entry is identified by its query id and its key** (`entryKey` in `util.ts`), in the diff baseline, the search index and the inspector list. Two queries can hold entries under one key, as kanban's board and archive queries do at `["b1"]`, and a key-only identity merged them. `DebugCacheEntry.queryId` comes from core. 1.0 removed the ignored `inspectorPollMs` prop. A pure timer-driven `isStale` transition, with no accompanying event, won't refresh the inspector until the next event.

## What's tested

291 tests across 20 files (`packages/devtools/tests/`). The 8A work added these:

- `store-stress.test.ts`, 4 tests. It drives 1,001 controllers and 50,000 events in 250-event frames, and the ring ends holding exactly its capacity. Doubling the events costs under 2.5× the time, and a late frame costs under 2.5× an early one. 10,000 siblings cost under 2.5× what 5,000 do.
- `store-foundation.test.ts`, 30 tests. Ring capacity, dropped count, clear and pause; structural sharing; frozen disposal; dispose-order pruning; queue bound under churn; the start trie; `search` for each kind; lazy, cached index builds; `toSearchText`.
- `panel-foundation.test.tsx`, 21 tests. A 10,000-row timeline, a 10,000-row cache log and a 1,000-node tree each mount a bounded window, and scrolling moves it. The file also covers lifted row state, group paging, the dropped indicator and frozen disposed rows. Plugin lanes run through a real `definePlugin` and `host.debug`. The omnibox tests cover the keys, the grouping, index reuse and every kind of jump.
- `virtual.test.tsx`, 7 tests. `VirtualList` against stubbed layout and `ResizeObserver`.
- `url-hash-hostile.test.tsx`, 12 tests, and `minify-css.test.ts`, 3 tests.

The older suites still pin the rest: `store.test.ts`, `panel.test.tsx`, `diff.test.ts`, `jsonview.test.tsx` and the `coverage-*` files. `core/tests/devtools-events.test.ts` pins the runtime-emit and `seq`/`causeId` contract.

## What's NOT included / follow-ups

- **`cache:subscribed`** wiring, for subscriber counts. It needs subscriber-path threading through `use → acquire`, which is overhaul T8.5. Declared in the union, not emitted.
- **A lane payload from mutation-queue.** Cross-tab and entities call `host.debug` since 1.0 (`cross-tab.md`, `entities.md`). The mutation queue does not yet.
- The rest of the overhaul: T8.5 tracing, T8.6 live actions, T8.7 environment simulation and the forms inspector, T8.9 session export and import, and the T8.10 UX pass. See [../decisions/devtools-overhaul.md](../decisions/devtools-overhaul.md).
- Signal dependency graph view.
