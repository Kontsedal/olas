# BACKLOG

The grab-bag for future work, ideas-in-progress, and post-v1 proposals.

**This is the only place such items live.** They do not live in `SPEC.md` (which is the design contract for what *is*), they do not live in `CLAUDE.md` (which is operating instructions), and they do not live in `.wiki/` (which describes the codebase as it stands). When you notice anything during work — a follow-up, a stray thought, "we should also…", "this would be cleaner if…" — append it here.

## How to use this file

- **Status tags** at the start of each item's heading:
  - `[idea]` — sketch, not committed to.
  - `[planned]` — agreed on, not started.
  - `[in-progress]` — actively being worked.
  - `[dropped]` — explicitly decided against; the reasoning matters.
- **Shipped items are removed.** Once an item lands in the code, delete the entry — the wiki and CHANGELOGs are the durable trail. Dropped items stay (tagged `[dropped]`) because the reasoning matters next time the idea resurfaces.
- **One heading per item.** A short body — context, constraints, what would change, where it'd land. If it grows large, link out to a wiki page or a draft RFC.

## Conventions

- Group by area (Packages, Storage, Devtools, Forms, …). Pure-idea items can live under "Loose ends" until they earn a category.
- Cite `SPEC.md §X.Y` when an item amends the spec; that signals "spec change required, not just an implementation."
- If a backlog item is implied by an existing spec line, quote the line.

---

## Packages

### [idea] `SetDataEvent.source === 'remote'` is redundant with `isRemote === true`

After §13.2 grew the `source: 'set' | 'fetch' | 'remote'` field, `source === 'remote'` carries the same information as `isRemote === true`. They're kept both for back-compat — existing plugins (cross-tab) gate on `isRemote`, new plugins (entities) can gate on `source`. Pick one in v2 and drop the other. Migration: keep `isRemote` (shorter, predates `source`) and reserve `source` strictly for `'set' | 'fetch'`.

### [idea] `@kontsedal/olas-offline` — offline-first reconnection layer atop the mutation queue

`@kontsedal/olas-mutation-queue` (shipped 0.0.5) covers durable enqueue + reload-replay for `defineMutation({ persist: true })`. The remaining offline layer would add: navigator-online detection, connection-state signal, conflict-resolution helpers, exponential-backoff schedule for inter-attempt waits, and an opinionated retry policy mid-session (today the queue only retries across page loads). Likely a thin package layered on top of `mutation-queue` + `@kontsedal/olas-persist`.

### [idea] `@kontsedal/olas-vue` — Vue adapter

Signal/ref interop. Out of scope for v1; the architecture is framework-neutral, so it's additive.

### [idea] `@kontsedal/olas-svelte` — Svelte adapter

Signal-as-store. Same scoping as Vue.

### [idea] `@kontsedal/olas-eslint-plugin` — lint rules that catch correctness issues we can't enforce at the type level

Examples:

- fetcher / `mutate` body must use the `signal` parameter.
- Controller factory must not be `async`.
- Do not import `@kontsedal/olas-core/testing` outside test files.

### [idea] `@kontsedal/olas-vite-plugin` — HMR automation

[from SPEC §16.5] Today's recommended HMR shape is "full root rebuild on hot update" (`root.dispose()` then `createRoot(...)` again, ~10 lines of Vite plugin glue). A first-party plugin would automate this.

### [idea] Devtools browser extension

[SPEC §14] An out-of-page extension that consumes `root.__debug.subscribe(...)` — controller tree inspector, cache timeline, mutation log, signal dependency graph, subscription view. The in-app `@kontsedal/olas-devtools` panel already covers the same surfaces; the extension would make them available without instrumenting the page.

## Storage / sync

### [idea] Cross-tab sync for infinite queries

[from T6.4] `@kontsedal/olas-cross-tab` and core's remote-apply paths (`applyRemoteSetData` / `applyRemoteInvalidate`) only handle regular (`'query'`) defs — infinite queries early-return, so their page arrays can't be applied cross-tab. The `crossTab: 'infinite'` / `'both'` option values were removed (they broadcast noise no peer could apply). Real support needs a receive path that reconstructs an infinite entry's page array + params (heavier payload, and the receiving tab may have a different page count / cursor), plus a size guard since page arrays can be large. Until then, cross-tab infinite lists should refetch (`invalidate`) rather than sync.

### [idea] Cross-`mutationId` causal ordering in the mutation queue

[from T6.2] `@kontsedal/olas-mutation-queue` replays entries serially **within** a `mutationId` (sorted by `seq`), but different `mutationId`s replay in parallel and cross-tab order isn't coordinated. So a logical dependency like `order/cancel` needing to land after `order/create` (distinct ids) isn't guaranteed on replay. A full fix needs a cross-id dependency DAG (or a global replay sequence with per-entry `dependsOn` edges) plus cross-tab agreement on that order — significant design. Today's guidance: model dependent steps under one `mutationId`, or make the server tolerant of out-of-order arrival (idempotency + reconciliation). Documented as a limitation in the package README.

## Forms

### [idea] Path-typed `form.fieldAt('a.b.c')` lookup

[from SPEC §20.7] The current public API uses the nested `form.fields.a.fields.b.fields.c` access. A `fieldAt<P extends FormPath<S>>(path: P): FieldAt<S, P>` would be ergonomic for deep forms but needs template-literal-type machinery that's implementation-heavy. Nested access covers ~95% of cases today, so this is opportunistic, not blocking.

### [idea] Route `formFromZod` root `.refine({ path })` issues onto fields

[noticed during T5.2] Core's `validator()` now returns `FormIssue[]` with paths, and form-level validators route them onto fields. But `formFromZod` still lifts root refines via `rootOnlyZodValidator`, which keeps only **empty-path** issues — so `z.object({...}).refine(fn, { path: ['confirm'] })` is dropped rather than landing on `confirm`. Routing them means distinguishing "root refine targeting a field" from a leaf-schema failure at the same path (leaf validators already own the latter), else the message double-reports. Options: filter root issues to `code: 'custom'` refinements and return them as `FormIssue[]`, or drop per-leaf `zodValidator`s and drive everything from one whole-form `validator(schema)` (bigger change — affects per-leaf `validateOn` / async semantics). Needs its own tests.

## Queries / data layer

### [idea] `useQuery({ suspense: true })` on a disabled query suspends forever

A disabled query (`enabled: () => false`) is `status: 'idle'` with no data, so a suspense hook throws `subscription.promise()` and stays suspended indefinitely (the fallback never resolves). T4.7 tried throwing a descriptive error instead, but an idle-with-no-data subscription is **indistinguishable from one torn down during `root.dispose()`** (both detach → idle), so the hard throw fired during teardown (false positives) and — thrown in render — React 19 re-reports it to node's `uncaughtException`, failing the vitest run. A clean fix needs a way to tell "intentionally disabled" from "transiently idle": e.g. surface an `enabled`/`disabled` flag on the subscription, or a dedicated `status: 'disabled'`. Until then, don't combine `suspense` with a disabled query; gate the whole subtree instead (`{condition && <SuspenseView/>}`).

### [idea] Full updater-replay rebasing for concurrent optimistic rollback

[from SPEC §6.4] Rollback today is snapshot-based with **chain-splice** ordering (T3.1): each `Snapshot` captures a baseline value, rolling back the top restores it, and rolling back a non-top layer threads its baseline down the chain so all-layers-rolled-back returns to the pre-mutation value. What it does **not** do: re-run the surviving layers' updater functions against a new baseline. So when A(+1) and B(+10) both apply and A fails first, the visible value stays 11 (both deltas) until B settles, rather than dropping to 10 (B's delta alone). True rebasing would store the updater fns (not just the pre-value), and on any rollback replay the still-live updaters in order over the current server/base value. Cost: `setData` must keep the updater closure alive for the snapshot's lifetime, and replay must be pure/idempotent. Worth it only if the "stale delta on screen until unwind" behavior bites a real app; `concurrency: 'serial'` sidesteps it for conflicting writes today.

### [idea] Rebase infinite-query optimistic snapshots on page-fetch success

[from SPEC §6.4] T3.4 rebases live optimistic snapshots onto fresh server truth in `Entry.applySuccess`, so a rollback after an intervening fetch restores server data, not a pre-fetch baseline. `InfiniteEntry` does **not** do this: its success paths (initial refetch, `fetchNextPage`, `fetchPreviousPage`) don't touch live snapshots' captured `prev`/`prevParams`. So an optimistic `setData` on an infinite query, followed by a successful page fetch and then a rollback, restores the pre-fetch pages (dropping an appended page). Rare (infinite + optimistic + concurrent fetch) and the rebase semantics for a paginated append are non-obvious (rebase `prev` to the *current* pages array?), so deferred. `query.cancel(...)` already lets callers avoid the race for infinite queries too.

### [idea] `offlineFirst` park for infinite queries

[from SPEC §5.5] T3.5 implemented the `offlineFirst` network-error park (wait for reconnect, then retry) in `Entry.runWithRetry`, but `InfiniteEntry.runFetch` does not — an `offlineFirst` infinite query that hits a network error while offline still surfaces the error rather than parking. `InfiniteEntry.isPaused` is wired for the `online`-mode offline-defer path only. Adding the park to `runFetch` needs per-direction handling (initial/next/prev) and interacts with the collapse-to-page-one behavior (T3.7). Deferred until infinite offline support is a real requirement.

### [idea] Dehydrate/hydrate infinite queries for SSR

[from SPEC §15] `dehydrate()` skips infinite entries (`client.ts` walks only `client.maps`, not `infiniteMaps`), so a server-rendered infinite list refetches its currently-loaded pages on the client after hydration (T3.7 part 2). Adding it needs: serialize `pages` + `pageParams` per infinite entry (heavier than a single-value payload), a `DehydratedInfiniteEntry` shape, hydration wiring in `bindInfiniteEntry` (seed `pages`/`pageParams`/status like `Entry`'s `initialData` path), and the streaming hydrator (`packages/react/src/streaming.ts:114`) to carry the page arrays. Deferred: the first-page refetch-on-client is acceptable for now, and page-array payloads bloat the SSR document. Documented as a limitation in SPEC §15 and the react README.

### [dropped] Next.js app-router / RSC support

Next.js is fundamentally misaligned with olas's philosophy: the controller-tree model assumes a client-driven, signal-reactive runtime where lifecycle, dispose, and `ctx.use` keying live in user space. RSC inverts that — the server owns rendering, components are render functions of props, and the framework dictates data-fetching boundaries. Trying to bolt olas onto that model would either (a) make olas a thin pass-through to whatever Next.js already does, defeating the point, or (b) require a parallel server-side controller runtime, doubling the surface area for an audience that's already well served by TanStack Query and `'use server'` actions.

**We don't need Next.js.** Olas is for logic-heavy client-driven apps (Linear/Notion class) where the controller tree carries real weight. Pages-router SSR via `dehydrate`/`hydrate` (already shipped, spec §11) covers the SSR case for the apps that benefit from it. RSC consumers should reach for the framework's native data-fetching story.

Keep this entry as a reference: future contributors will ask "why not Next?" and the answer needs to be findable.

## Controllers

### [idea] `root.replaceController(path, newDef)` — in-place HMR-friendly swap

[from SPEC §16.5] Surgically replace one controller while preserving siblings and cache subscriptions. Significant complexity (subscription rebinding, prop reconciliation). The current recommended HMR shape (full root rebuild) sidesteps this; revisit only if rebuild ergonomics turn out to be a real friction point.

## Devtools

The flagship **devtools overhaul** (causal-timeline debugger) is partially landed: T8.1
(event backbone — `seq`/`t`/`causeId`, `cache:set-data`, `snapshot:*`, ambient-cause
threading, event-driven inspector) and T8.4 (the causal Timeline tab + structural diffs)
shipped 2026-07-28. The remaining phases live in
`.wiki/candidates/decisions/devtools-overhaul.md` (T8.2 virtualize + ring buffer, T8.3
omnibox, T8.5 subscription/effect tracing, T8.6 live actions, T8.7 env sim + forms
inspector, T8.8 plugin lanes, T8.9 session traces, T8.10 UX pass). The small T8.1
leftovers below are terse enough to live here.

### [idea] Wire `cache:subscribed` / `cache:unsubscribed`

The `cache:subscribed` variant is declared in the `DebugEvent` union but never emitted —
it needs the subscriber's controller path threaded through `ctx.use` → `ClientEntry.acquire`
(and a matching `cache:unsubscribed` on `release` 1→0). Feeds per-entry subscriber counts
in the inspector and "who's watching this" in the timeline. Part of overhaul T8.5.

### [idea] Devtools events for infinite queries

T8.1 wired `cache:fetch-*` + `snapshot:*` only for regular queries — `InfiniteEntry` has
no `EntryEvents` hooks, so infinite fetches/optimistic writes don't appear on the timeline
(only `setInfiniteData` emits `cache:set-data`). Add the same hook bundle to `InfiniteEntry`
(per-direction: initial / next / prev) and wire it in `InfiniteClientEntry`.

### [idea] Timeline group ordering by most-recent activity

`groupByCause` positions a cause-group at its FIRST event's `seq`, so a long-running group
whose latest event is recent still sorts low (newest-first is by group start, not last
activity). Fine for the common single-mutation case; revisit if multi-cause interleaving
gets confusing — order groups by their last event's `seq` instead.

## Documentation / polish

### [in-progress] Inline TSDoc on all exported types

The major exports carry one-line descriptions (e.g. `defineQuery`, `defineController`, `useField`). What's still missing: `@example` blocks attached to public surfaces and TSDoc on the long tail of utility exports. Going through each package's `index.ts` re-exports systematically and adding one `@example` per primitive would materially improve IDE hover. Worth doing alongside the next API.md sweep.

## Examples

### [idea] Extract `examples/_shared/ui/` design system

The flagship kanban example has a complete in-app design system at
`examples/kanban/src/ui/` — tokens (oklch palette + light/dark/density),
motion keyframes, and ~14 React primitives (Button, Card, Avatar, Tag,
Toast, Dialog, …). When stock-ticker or reader-ssr are next due for a UI
uplift, lift these out to `examples/_shared/ui/` and have each example
extend the tokens. Already deliberately kept kanban-local for now to
avoid premature abstraction — see the `cryptic-questing-twilight.md`
plan for the rationale.

### [idea] virtualized-table example lacks a controller test

The other three examples (kanban, reader-ssr, stock-ticker) each ship a `tests/` suite driving their controller via `createTestController` with no DOM. `examples/virtualized-table` has none — yet the root README's examples section implies every example is covered ("Every business-logic surface in these examples is covered by a controller test"). Either add a `tests/controller.test.ts` for `tableController` (row upsert, per-row optimistic edit + `onError` rollback, `selection` range + bulk-apply, title filter) — a natural fit since it's the "rows are data" showcase — or soften the README claim. Adding the test is the better close: the controller is pure and already DOM-free.

## Tooling / DX

### [idea] Local `pnpm lint` fails on Windows (CRLF vs biome `lineEnding: "lf"`)

`biome.json` sets `formatter.lineEnding: "lf"` but the repo has no `.gitattributes`, so with `core.autocrlf=true` (the default on the maintainer's Windows box) every source file is CRLF in the working tree and `biome check .` reports "Formatter would have printed…" for *every* file. CI passes only because Linux checks out LF. Fix options: add `.gitattributes` (`* text=auto eol=lf`) so checkouts are LF, then `git add --renormalize .` once; or set `core.autocrlf=input` locally. Deferred because renormalizing mid-remediation would bury the real diffs in line-ending noise. Local rule-checking meanwhile is `pnpm exec biome lint .` (skips the formatter); CI verifies formatting.

### [idea] Satellite/integration packages typecheck against built `dist`, not `src`

`tsconfig.base.json` has no `paths`, so `@kontsedal/olas-*` imports in the satellite packages (react, persist, entities, …) and the integration suite resolve to each package's built `dist/*.d.ts` (via `exports.types`). Consequences: (1) `pnpm typecheck` needs a prior `pnpm build` or it sees stale/absent types — and **CI runs `typecheck` BEFORE `build`**, so a fresh checkout can't resolve them; (2) core src type changes aren't seen by satellites until a rebuild. Adding `paths` → src does NOT work cleanly (it pulls core src into each satellite's `rootDir`, and `__DEV__` isn't declared outside the build-time define). Proper fix belongs in T7.2: reorder CI to `build` before `typecheck` (or add a pre-typecheck build step), and/or add TS project references plus a `__DEV__` ambient declaration so src↔src typecheck is viable. Surfaced when T1.2 added `DehydratedEntry.id` — the integration suite's hand-built payload only typechecked after a rebuild.

## Loose ends

### Internal peer ranges have no upper bound

The nine sub-packages declare `peerDependencies: { "@kontsedal/olas-core": ">=0.3.0" }`. The intent at 0.3.0 was `>=0.3.0 <1.0.0`; `changeset version` rewrote it to `>=0.3.0`, dropping the clause it doesn't manage. Consequence: `olas-react@0.4.x` nominally accepts a future `olas-core@1.x`, so the range doesn't fence off a breaking core. Cosmetic while all ten ship in lockstep at one version, and it self-resolves at 1.0 (a caret admits 1.1.0). Options if it starts mattering: re-add the ceiling as a post-`version` step in the release script, or move to a caret once on 1.x.

**The version-cascade half of this is fixed** — it was never really about the range. Widening to `>=0.3.0` at 0.3.0 aimed at the wrong half of the condition: `shouldBumpMajor` short-circuits on `!onlyUpdatePeerDependentsWhenOutOfRange`, which defaults to **false**, so the range was never consulted at all and *any* non-patch core bump majored all nine peer-dependents, which the `fixed` group then propagated back to core. 0.4.0 sets `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true` in `.changeset/config.json`, which makes the range load-bearing (verified: `changeset status` computes minor, `changeset version` produces 0.4.0 across all ten and leaves the peer ranges untouched). Keep the flag in mind when upgrading `@changesets/cli` — the name advertises that it can change in a patch.

(nothing tagged yet — drop short, unclassified notes here when they don't fit above)

### CI releases cannot complete without two repo-settings changes

The 0.4.0 release had to be finished by hand twice, for reasons the workflow cannot fix from inside:

1. **`GitHub Actions is not permitted to create or approve pull requests`** — the changesets action built and pushed `changeset-release/main` but could not open the Version Packages PR (run 30610698827). Fix: Settings → Actions → General → Workflow permissions → allow Actions to create PRs. Until then, every release needs a manual `gh pr create --head changeset-release/main`.
2. **No `NPM_TOKEN` repo secret exists** (`gh secret list` is empty), so the publish step dies with `ENEEDAUTH` on all ten packages (run 30610849873). 0.3.0 and 0.4.0 were both published from a locally-authenticated machine (`npm whoami` → kontsedal) via `pnpm release`. Fix: mint an npm automation token and `gh secret set NPM_TOKEN`.

Neither blocks releasing — the local path works — but the release.yml pipeline is decorative until both are done.
