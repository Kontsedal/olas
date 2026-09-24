---
name: devtools-overhaul
description: "The devtools overhaul, from a polling JSON panel to a causal-timeline debugger. Phase 8A has landed: event backbone, windowed lists, ring buffer, keyed tree, omnibox and plugin lanes. 8B-8D are the open design."
type: decision
covers:
  - packages/devtools/src/store.ts
  - packages/devtools/src/search.ts
  - packages/devtools/src/virtual.tsx
  - packages/devtools/src/Omnibox.tsx
  - packages/devtools/src/events.ts
edges:
  - { type: related, target: ../modules/devtools-panel.md }
  - { type: related, target: ../modules/devtools.md }
  - { type: related, target: ../candidates/backlog.md }
  - { type: related, target: ../flows/devtools-causal-timeline.md }
  - { type: tested-by, target: ../../packages/devtools/tests/store-stress.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/store-foundation.test.ts }
  - { type: tested-by, target: ../../packages/devtools/tests/panel-foundation.test.tsx }
last_verified: 2026-09-24
confidence: medium
---

# Devtools overhaul

> **Status (2026-09-24): 8A has landed.** T8.1, the event backbone, and T8.4, the causal
> timeline, shipped on 2026-07-28. T8.2, T8.3 and the lane half of T8.8 shipped on
> 2026-09-24. The tasks marked ✅ below are implemented. The rest of 8B, and all of 8C and
> 8D, are the open design. The remediation's **T6.3** fixed the outright devtools bugs
> before any of this: the false `[Circular]`, the unbounded tree, the per-keystroke
> re-stringify and the run-to-success pairing. See `modules/devtools-panel.md`.

## Landed (2026-09-24): the rest of 8A

### T8.2: windowed lists, bounded memory, O(1) apply

- **The timeline is a ring buffer.** `DevtoolsStore` keeps the newest
  `maxTimelineEntries` events, 10,000 by default, and `droppedEvents$` counts the events it
  overwrote. The timeline toolbar shows that count, and Clear resets it. The three
  per-view logs use the same `Ring` class at their `maxEntries` cap (`store.ts`).
- **Log arrays are built on read.** A flush moves buffered items into a ring at O(1) each.
  The ring copies its items into an array only when someone reads the signal, and the
  panel reads once per frame.
- **The tree is keyed and mutable.** The store finds a node by its path key in a `Map`,
  and each node holds its children in a `Map` by segment. A lifecycle event costs
  O(path depth). The panel reads immutable `ControllerNode` snapshots, which the store
  rebuilds only along the changed paths, so an untouched subtree keeps its identity.
- **Pruning runs in dispose order.** The `maxDisposedNodes` cap is unchanged. A queue of
  disposals replaces the whole-tree walk the old code ran on every dispose, so the
  earliest-disposed subtree goes first. The old code picked the earliest-constructed one.
- **A disposed node is greyed and frozen.** The store reads each `ctx.debug` signal once,
  at dispose time, and keeps the value it held. The Tree draws the node in the dim tier.
- **Mutation start times live in a trie by path.** The old flat map was scanned on every
  dispose, and under load that scan was the store's largest cost.
- **`VirtualList` windows every long view** (`virtual.tsx`). That covers the Tree, the
  Timeline and the four log lists. It follows the `examples/virtualized-table` approach
  without that example's `@tanstack/react-virtual` dependency. Rows start at an estimated
  size, keep a measured size by key, and prefix sums plus a binary search pick the window.
  The Tree renders as flat rows with `aria-level`. An open cause-group mounts 100 events
  at a time behind a "Show more" button, because windowing inside a windowed row costs more
  code than a page does.

The stress test, `store-stress.test.ts`, drives 1,001 controllers and 50,000 events in
250-event frames. It asserts three ratios, because an absolute time would flake on CI.
Doubling the events costs under 2.5 times the time. A late frame costs under 2.5 times an
early one. 10,000 sibling controllers cost under 2.5 times 5,000. On the authoring machine a
frame took a median 0.09 ms, and the 50,000-event run took 19 ms.

### T8.3: the omnibox

One search box sits above the tabs, and `/` focuses it from anywhere in the panel except a
text field. It matches controller names and paths, query ids, key args, mutation names, form
field paths and errors, and payload content (`search.ts`). Results come back grouped by kind.
Enter jumps to the active result. The panel switches tab, clears that tab's filter, opens a
collapsed ancestor or cause-group, shows a hidden lane and highlights the row.

`SearchIndex` builds on the first search after a change. It caches each item's text by
object identity, so a rebuild converts only new or changed values. A keystroke with no
change in between reuses the built index. `toSearchText` stops each value at 2,000
characters, which bounds the index to about 20 MB for a full ring of large payloads.

### T8.8, the lane half

Core emits `plugin:event`, with the plugin's name, for every `host.debug(payload)` call
(`plugin/host.ts`). The timeline badges each of those rows with the plugin name. A toolbar
shows one chip per lane, `core` first, and a chip hides or shows its lane. No core change was
needed. The per-plugin payloads that T8.8 describes below are not emitted yet.

### The bundle

The devtools size budget is 14.1 KB brotli, and 8A took the bundle from 13.76 KB to 17.88 KB.
The build now minifies the inline stylesheet (`scripts/minify-css.ts`), which gave back
2.1 KB. The source keeps its CSS comments, because they carry the reasoning of
`ui-rules.md`. The remaining growth is the search index and omnibox, the windowed list, the
keyed tree and ring, and the panel wiring for lanes and jumps.

## Landed (2026-07-28): T8.1 and T8.4

**T8.1 — event backbone (partial: no poll-kill-via-synthetic-event; done via store seed).**
`DebugEvent` gained optional `seq`, `t` and `causeId`; `cache:set-data` (source + data) and
`snapshot:push`/`rollback`/`finalize`; a dev-only ambient cause (`__runWithCause`) threads a
mutation's `runId` into the writes it triggers, and fetches share a `fetchId`. The 800ms
inspector poll is gone — the store seeds `cacheState$` from `queryEntries()` on attach and
refreshes on cache events (rather than emitting a synthetic `cache:snapshot` per entry; same
observable result, less coupling). Not done from T8.1: `cache:subscribe/unsubscribe` wiring,
`effect:run`, `form:field-change`, `scope:*`, and the generic `plugin:event` envelope.

**T8.4 — causal timeline.** The panel's default tab groups events by `causeId` into
collapsible cause-chains and renders a structural before/after diff (`diff.ts`, written in
the devtools package — core internals not imported) on each `cache:set-data`. The acceptance
scenario (a failing latest-wins/optimistic mutation shown as one apply→rollback group) is
covered by `packages/devtools/tests/panel.test.tsx`.

Everything below that is not ticked ✅ is still a proposal.

## Why

Today the panel is a **polling JSON viewer**: it re-reads the whole cache every ~800ms
and diffs, which is wasteful and *lossy* (events between polls are invisible; ordering
is reconstructed by guesswork), and it offers **zero actions** — you can look (at
possibly-stale data) but you can't *do* anything.

## North star

Olas owns the whole vertical — signals, controllers, lifecycle, query cache, mutations,
forms, plugins — through one dev-event bus (`root.debug`). No competitor (Redux
DevTools, TanStack Query devtools, MobX tools) can correlate across those layers; each
sees one slice. The exceptional panel answers the three questions every debugging
session is about, in one place:

1. **"Why did this change?"** — click any state, see the causal chain that produced it
   (mutation → optimistic `setData` → fetch settle → entities backprop → cross-tab echo).
2. **"Why did this render or refetch?"** — subscription and effect tracing.
3. **"What happens if…?"** — act on live state: refetch, invalidate, edit cache, force
   error/loading, suspend/resume controllers, go offline.

Everything is dev-only (`__DEV__`-gated in core; the panel is its own package so prod
bundles never see it). Sub-phases are ordered — **8A is the foundation** everything else
stands on. **Prerequisite: the T6.3 devtools bug fixes (already landed).**

## 8A — foundation: event-driven, virtualized, correlated (no new features yet)

- ✅ **T8.1 — kill the 800ms poll; make the store fully event-driven.** *(Landed 2026-07-28 — see the Landed note above for what shipped vs. deferred.)* Extend the
  `DebugEvent` union so the cache narrates itself, `__DEV__`-gated and zero-cost when the
  bus has no subscribers. New events: `cache:fetch-start`, `cache:fetch-settle`
  (success/error/aborted + duration), `cache:set-data` (with `source:
  'mutate'|'set'|'remote'|'fetch'`, reusing the §13.1 plugin vocabulary),
  `cache:invalidate`, `cache:gc`, `cache:subscribe`/`unsubscribe` (per entry, with
  subscriber controller path), `mutation:enqueue/run/settle` (add a stable `runId`),
  `snapshot:push/rollback/finalize` (the optimistic stack), `form:field-change` and
  `form:validate-settle` (name-pathed, value elided by default — see T8.7),
  `scope:provide/inject`, and a generic `plugin:event` envelope (see T8.8). The store
  consumes ONLY events; delete the poller. Keep one initial-snapshot request (extend the
  bus's live-tree replay to emit a synthetic `cache:snapshot` per live entry on attach).
  **Every event carries a monotonic `seq`, a `timestamp`, and a `causeId` where core can
  cheaply know it** — a mutation's `runId` flows into the `setData` it triggers, the
  rollback it causes, and its settle; a fetch's id flows into its settle + set-data. This
  correlation backbone is cheap at emit time and *impossible to reconstruct later* — do
  not skip it. Acceptance: kanban running, panel open — no `setInterval`, all cache
  changes appear within one frame, events strictly `seq`-ordered.
- ✅ **T8.2 — virtualize everything; bound all memory.** *Landed 2026-09-24, see above.* Windowed rendering for tree,
  timeline and cache list (reuse `examples/virtualized-table`'s approach, no new dep).
  Event log → ring buffer (default 10k, configurable) with a dropped-count indicator.
  Disposed controllers retained-but-capped (from T6.3), greyed with dispose-time state
  frozen. Replace per-event immutable path-clone + linear `findIndex` with a keyed
  `Map<pathKey, node>` (O(1)/event). Acceptance: synthetic stress test (1,000
  controllers, 50k events) — store apply loop stays sub-16ms/frame (time the loop, not
  the DOM; assert no O(n²)).
- ✅ **T8.3 — search that works.** *Landed 2026-09-24, see above.* One omnibox (`/` to focus) matching controller
  names/paths, query names, key args, mutation names, form field paths, and payload
  CONTENT — against a lazily-built, invalidated-on-change stringified index (never
  per-keystroke re-stringification). Results grouped by kind; Enter jumps + highlights.

## 8B — the killer feature: causal timeline ("why did this change?")

- ✅ **T8.4 — unified timeline with cause-chains.** *(Landed 2026-07-28.)* A time-ordered stream of ALL events
  (from T8.1), filterable by kind/controller/query, pausable (record button), relative
  timestamps. Events sharing a `causeId` render as one collapsible group, e.g.
  `updateName.run(42)` ▸ `snapshot:push users/['1']` ▸ `cache:set-data (mutate)` ▸
  `cache:fetch-settle error` ▸ `snapshot:rollback` ▸ `mutation:settle (error, 230ms)`.
  Every `set-data` row expands to a **structural before/after diff** (added/removed/
  changed keys highlighted), not two JSON dumps — write a small diff walker in the
  devtools package (core's structural-share walker is a reference for cycle handling; do
  NOT import core internals). Acceptance: in kanban, a failing latest-wins mutation shows
  the full optimistic-apply → supersede-rollback → re-apply chain as one readable group.
- **T8.5 — subscription & effect tracing ("why did this render/refetch?").** Core
  (`__DEV__`): `ctx.effect(fn, { label? })` optional label; effects + query bindings
  already pass through wrappers — add run-count + last-run-timestamp; emit `effect:run`
  (throttled, coalesced per effect per frame). React: `use()`/`useQuery`/`useField`
  register their subscription with the bus (optional `debugLabel` + anonymous counting;
  stack-based names are too fragile). Panel: each controller node shows its effects with
  run counts (a hot effect >30/s gets a heat marker); each entry/field shows live
  subscriber count + which controllers/components hold it. This surfaces the very bugs
  this library's audit found (collection reconcile storms, double-activated effects) *to
  the end user*. Acceptance: the T2.3 collection-reconcile-storm bug (pre-fix) would be
  visibly diagnosable via the climbing run-count.

## 8C — act on state: the panel does things

- **T8.6 — debug control API + cache actions.** A `__DEV__`-only `DebugControls` next to
  the bus on `root.debug`: `refetch, invalidate, removeEntry, write,
  forceEntryState('loading'|'error'), suspendController, resumeController,
  disposeController`, implemented over existing internals (`write` is the canonical
  write `host.queries.write` makes; `forceEntryState` sets the
  entry's signals directly and marks it "forced" until the next real fetch). Panel: per
  entry — Refetch, Invalidate, Remove, Edit-as-JSON (validated), Force loading or
  Force error; per controller — Suspend, Resume and Dispose (confirm); per form — Reset,
  per field — set value. **Guardrail:** every control action emits its own timeline event
  tagged `source: 'devtools'` so self-inflicted changes are never mistaken for app
  behavior. Acceptance: in reader-ssr, forcing an entry error renders the app's error UI;
  a Refetch restores it — no app-code changes.
- **T8.7 — environment simulation + forms inspector.** Offline toggle (dev-only patches
  `navigator.onLine` + dispatches `offline`/`online` events — instantly exercises
  networkMode, mutation-queue reconnect replay, persist behavior); a `delayFetches(ms)`
  latency-injection debug control in core's fetch wrapper. Forms inspector tab per
  form-owning controller: live field tree with value/dirty/touched/errors/isValidating +
  the structural-dirty flag (T5.1), validation events in the timeline. **Sensitive-value
  elision:** field values render only on click-to-reveal, and `form:field-change` events
  carry paths, not values, unless reveal is on.
- **T8.8 — plugin lens.** *The lanes landed 2026-09-24 over the existing `plugin:event` and `host.debug`. The per-plugin payloads below are open.* The generic `plugin:event` envelope (T8.1) gets a dedicated
  timeline lane per plugin: cross-tab shows sent/received/deduped with peer ids; entities
  shows walk/backprop counts per set-data (surfacing the "walk cost on every event" tax);
  mutation-queue shows enqueue/replay/attempt lifecycles with durable-entry contents.
  Plugins attach via a tiny core helper `emitPluginDebug(name, payload)` — third-party
  plugins get the lane for free.

## 8D — polish that makes it feel exceptional

- **T8.9 — session traces: export, import, share.** Record → stop → export the event ring
  + initial snapshot as one JSON file (versioned `{ format: 1, … }`). The panel can
  IMPORT + replay it read-only (scrub the timeline, inspect any moment's derived state).
  This turns "it breaks sometimes on my machine" into an attachable artifact —
  the feature that does the most for a young library's bug reports. Acceptance:
  export from kanban, import into a fresh session, scrub to a mutation, read its
  cause-chain.
- **T8.10 — UX pass.** Keyboard (`/` search, `j/k` timeline walk, `Esc` close); panel
  state (dock side, size, tab, filters) persisted via `@kontsedal/olas-persist`
  (dogfooding); `prefers-color-scheme` + manual override; highlight-on-update pulses
  (CSS only, no layout thrash); teaching empty states. Update `packages/devtools/README.md`
  with annotated screenshots + a "devtools tour" in the kanban example README.

## Promotion

This page left `candidates/` on 2026-09-24, when 8A landed, which was its promotion
criterion. The `DebugEvent` union and the `causeId` correlation are a working contract in
core now. `SPEC.md` does not pin them yet.
