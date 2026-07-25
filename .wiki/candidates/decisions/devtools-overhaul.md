---
name: devtools-overhaul
description: "Proposed devtools overhaul — turn the polling JSON panel into a causal-timeline debugger. Candidate design (unbuilt); rescued from the transient REMEDIATION.md Phase 8."
type: decision
edges:
  - { type: related, target: ../../modules/devtools-panel.md }
  - { type: related, target: ../../modules/devtools.md }
  - { type: related, target: ../backlog.md }
last_verified: 2026-07-25
confidence: candidate
---

# Devtools overhaul — proposed design (candidate, unbuilt)

> **Status: candidate / proposal.** This is a *future* design, not a description of
> what the code does today. It was authored as "Phase 8" of the 2026-07 remediation
> plan (`REMEDIATION.md`, a transient file that gets deleted when the remediation
> lands) and is preserved here so the vision isn't lost. Nothing below is implemented.
> The remediation's **T6.3** already fixed the outright devtools *bugs* (false
> `[Circular]`, unbounded tree, per-keystroke re-stringify, run→success pairing) — see
> `modules/devtools-panel.md`. This overhaul is purely additive on top of that.

## Why

Today the panel is a **polling JSON viewer**: it re-reads the whole cache every ~800ms
and diffs, which is wasteful and *lossy* (events between polls are invisible; ordering
is reconstructed by guesswork), and it offers **zero actions** — you can look (at
possibly-stale data) but you can't *do* anything.

## North star

Olas owns the whole vertical — signals, controllers, lifecycle, query cache, mutations,
forms, plugins — through one dev-event bus (`root.__debug`). No competitor (Redux
DevTools, TanStack Query devtools, MobX tools) can correlate across those layers; each
sees one slice. The exceptional panel answers the three questions every debugging
session is actually about, in one place:

1. **"Why did this change?"** — click any state, see the causal chain that produced it
   (mutation → optimistic `setData` → fetch settle → entities backprop → cross-tab echo).
2. **"Why did this render / refetch?"** — subscription and effect tracing.
3. **"What happens if…?"** — act on live state: refetch, invalidate, edit cache, force
   error/loading, suspend/resume controllers, go offline.

Everything is dev-only (`__DEV__`-gated in core; the panel is its own package so prod
bundles never see it). Sub-phases are ordered — **8A is the foundation** everything else
stands on. **Prerequisite: the T6.3 devtools bug fixes (already landed).**

## 8A — foundation: event-driven, virtualized, correlated (no new features yet)

- **T8.1 — kill the 800ms poll; make the store fully event-driven.** Extend the
  `DebugEvent` union so the cache narrates itself, `__DEV__`-gated and zero-cost when the
  bus has no subscribers. New events: `cache:fetch-start`, `cache:fetch-settle`
  (success/error/aborted + duration), `cache:set-data` (with `source:
  'mutate'|'set'|'remote'|'fetch'`, reusing the §13.2 plugin vocabulary),
  `cache:invalidate`, `cache:gc`, `cache:subscribe`/`unsubscribe` (per entry, with
  subscriber controller path), `mutation:enqueue/run/settle` (add a stable `runId`),
  `snapshot:push/rollback/finalize` (the optimistic stack), `form:field-change` /
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
- **T8.2 — virtualize everything; bound all memory.** Windowed rendering for tree /
  timeline / cache list (reuse `examples/virtualized-table`'s approach, no new dep).
  Event log → ring buffer (default 10k, configurable) with a dropped-count indicator.
  Disposed controllers retained-but-capped (from T6.3), greyed with dispose-time state
  frozen. Replace per-event immutable path-clone + linear `findIndex` with a keyed
  `Map<pathKey, node>` (O(1)/event). Acceptance: synthetic stress test (1,000
  controllers, 50k events) — store apply loop stays sub-16ms/frame (time the loop, not
  the DOM; assert no O(n²)).
- **T8.3 — search that works.** One omnibox (`/` to focus) matching controller
  names/paths, query names, key args, mutation names, form field paths, and payload
  CONTENT — against a lazily-built, invalidated-on-change stringified index (never
  per-keystroke re-stringification). Results grouped by kind; Enter jumps + highlights.

## 8B — the killer feature: causal timeline ("why did this change?")

- **T8.4 — unified timeline with cause-chains.** A time-ordered stream of ALL events
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
  the bus on `root.__debug`: `refetch / invalidate / removeEntry / setEntryData /
  forceEntryState('loading'|'error') / suspendController / resumeController /
  disposeController`, implemented over existing internals (`forceEntryState` sets the
  entry's signals directly and marks it "forced" until the next real fetch). Panel: per
  entry — Refetch / Invalidate / Remove / Edit-as-JSON (validated) / Force loading /
  Force error; per controller — Suspend / Resume / Dispose (confirm); per form — Reset,
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
- **T8.8 — plugin lens.** The generic `plugin:event` envelope (T8.1) gets a dedicated
  timeline lane per plugin: cross-tab shows sent/received/deduped with peer ids; entities
  shows walk/backprop counts per set-data (surfacing the "walk cost on every event" tax);
  mutation-queue shows enqueue/replay/attempt lifecycles with durable-entry contents.
  Plugins attach via a tiny core helper `emitPluginDebug(name, payload)` — third-party
  plugins get the lane for free.

## 8D — polish that makes it feel exceptional

- **T8.9 — session traces: export, import, share.** Record → stop → export the event ring
  + initial snapshot as one JSON file (versioned `{ format: 1, … }`). The panel can
  IMPORT + replay it read-only (scrub the timeline, inspect any moment's derived state).
  This turns "it breaks sometimes on my machine" into an attachable artifact — arguably
  the single highest-leverage feature for a young library's bug reports. Acceptance:
  export from kanban, import into a fresh session, scrub to a mutation, read its
  cause-chain.
- **T8.10 — UX pass.** Keyboard (`/` search, `j/k` timeline walk, `Esc` close); panel
  state (dock side, size, tab, filters) persisted via `@kontsedal/olas-persist`
  (dogfooding); `prefers-color-scheme` + manual override; highlight-on-update pulses
  (CSS only, no layout thrash); teaching empty states. Update `packages/devtools/README.md`
  with annotated screenshots + a "devtools tour" in the kanban example README.

## Promotion criteria

Promote out of `candidates/` (into `.wiki/decisions/` or split into per-area pages, and
graduate to `SPEC.md` if the event-bus contract is committed) when 8A lands — at that
point the `DebugEvent` union + `causeId` correlation become a real design contract worth
pinning, not a proposal.
