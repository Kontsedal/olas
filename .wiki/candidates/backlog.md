---
name: candidate-backlog
description: "Staging backlog of substantial, forward-looking proposals (rich design candidates). The terse grab-bag of smaller ideas stays in the repo-root BACKLOG.md."
type: overview
edges:
  - { type: related, target: decisions/devtools-overhaul.md }
last_verified: 2026-07-28
confidence: candidate
---

# Candidate backlog — substantial proposals

This page stages **forward-looking design proposals** that are too rich to live as a
one-line entry in the repo-root `BACKLOG.md` — things that need a real design doc before
anyone builds them. It lives under `.wiki/candidates/` because every item here is
**speculative and unbuilt** (`confidence: candidate`, excluded from authoritative wiki
queries).

**Division of labour with `BACKLOG.md`:** `BACKLOG.md` (repo root) remains the single
terse grab-bag for *all* future work — small follow-ups, ideas, dropped items with their
reasoning. This page does NOT duplicate it. It only (a) hosts the flagship multi-page
proposals, and (b) spotlights the handful of `BACKLOG.md` items substantial enough to be
worth graduating into their own design doc later. When an item here starts, promote it
out of `candidates/` and delete its `BACKLOG.md` line per the BACKLOG protocol.

## Flagship

### [candidate] Devtools overhaul — causal-timeline debugger *(partially landed 2026-07-28)*

The big one. Turn the polling JSON panel into an event-driven, virtualized debugger that
answers "why did this change?" (causal timelines with cause-chains + structural diffs),
"why did this render/refetch?" (subscription + effect tracing), and "what happens if…?"
(act on live state — refetch/invalidate/edit/force-error/suspend/go-offline), plus
export/import session traces. Olas is uniquely positioned here because one dev-event bus
(`root.__debug`) already spans signals → controllers → cache → mutations → forms →
plugins, a correlation no single-slice competitor (Redux/TanStack/MobX devtools) can do.

**Shipped (2026-07-28):** **T8.1** event backbone (`seq`/`t`/`causeId` on every event,
`cache:set-data` + `snapshot:*`, ambient-cause threading, event-driven inspector — poll
killed) and **T8.4** the causal timeline (cause-chains + structural before/after diffs).
See `modules/devtools.md`, `modules/devtools-panel.md`,
`flows/devtools-causal-timeline.md`. **Remaining:** T8.2 (virtualize + ring buffer), T8.3
(omnibox), T8.5 (subscription/effect tracing), T8.6 (live actions), T8.7 (env sim + forms
inspector), T8.8 (plugin lanes), T8.9 (session traces), T8.10 (UX pass) — plus the T8.1
leftovers (`cache:subscribe/unsubscribe`, `effect:run`, `form:field-change`, `scope:*`,
`plugin:event`).

→ **Full design: [`decisions/devtools-overhaul.md`](decisions/devtools-overhaul.md)**
(sub-phases 8A foundation → 8B causal timeline → 8C live actions → 8D polish, ten tasks;
T8.1 + T8.4 marked ✅ there). The devtools *bugs* were already fixed (remediation T6.3,
see `modules/devtools-panel.md`); this is additive.

## Other proposals worth a design doc (spotlighted from `BACKLOG.md`)

Terse today; each would warrant its own candidate page if picked up. Reasoning + current
one-liners live in `BACKLOG.md`.

- **`@kontsedal/olas-offline`** — an offline-first reconnection layer over
  `mutation-queue` + `persist`: navigator-online detection, a connection-state signal,
  conflict-resolution helpers, mid-session (not just cross-reload) retry with backoff.
  The natural home for logic currently smeared across mutation-queue's replay and
  realtime's `onReconnect`.
- **Infinite-query first-class completeness** — a cluster the remediation deliberately
  deferred: (1) dehydrate/hydrate infinite queries for SSR (today server-rendered
  infinite lists refetch on the client); (2) cross-tab sync of infinite payloads (the
  `crossTab: 'infinite'|'both'` values were removed in T6.4 because no peer could apply
  them); (3) cross-`mutationId` causal ordering in the queue (T6.2). Each needs a heavier
  payload/coordination design; together they'd make infinite queries a peer of regular
  ones across SSR, cross-tab, and durable replay.
- **Full updater-replay rebasing for concurrent optimistic rollback** — T3.1 shipped the
  chain-splice fix (final state is correct); true TanStack-style *rebasing* (re-run each
  live updater against fresh server truth on every settle) is the complete-but-heavier
  version.
- **Devtools browser extension** — an out-of-page consumer of `root.__debug` (complements,
  doesn't replace, the in-app panel). Best pursued *after* the overhaul above, since it
  reuses the same event bus + trace format.
- **Ecosystem adapters & tooling** — `@kontsedal/olas-vue` / `-svelte` (signal interop),
  `@kontsedal/olas-eslint-plugin` (catch correctness rules the type system can't — e.g.
  "fetcher must use its `signal`"), `@kontsedal/olas-vite-plugin` (HMR full-root-rebuild
  automation). Additive, framework-neutral by design.

## See also

- `../../BACKLOG.md` — the full terse backlog (all areas: packages, storage/sync, forms,
  queries, controllers, docs, tooling, loose ends).
- `../index.md` — the authoritative wiki catalog (this page and its children are NOT in
  it as facts; they're proposals).
