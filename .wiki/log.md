# Wiki log

Chronological, append-only record of wiki activity. Greppable. Newest at the bottom.

Format: `## [YYYY-MM-DD HH:MM] <kind> | <short summary>` where `<kind>` ∈ {ingest, lint, candidate-promote, contradict, query-archive, schema-change, refine}.

---

## [2026-05-18 17:55] ingest | bootstrap

Initial wiki creation. Authored the schema (`../CLAUDE.md`), `index.md`, `overview.md`, `glossary.md`, and the first round of modules / entities / flows / decisions / pitfalls.

Coverage at bootstrap:
- All four packages have a module page.
- 5 entity pages: ctx, controller-instance, entry, query-client, mutation.
- 4 flow pages: subscription, mutation concurrency, SSR, construction rollback.
- 5 decision pages.
- 8 pitfall pages — these capture real bugs and surprises encountered while implementing phases 0–12.

Source for the bootstrap is the agent's working memory from implementing the codebase. Pages with `confidence: high` are also cross-verifiable against `SPEC.md` + source code. Pages without spec backing are `confidence: medium`.

Followups:
- Phase 10 (`@kontsedal/olas-react` + scopes) lands → add `modules/react.md`, `entities/scope.md`, `flows/use-root.md`.
- No automated lint yet; manual passes only. A `scripts/wiki-lint.ts` is a TODO.

## [2026-05-18 18:35] refine | self-critique pass

Asked "do I like the wiki?", produced an honest critique, then refined based on it.

What changed:

- **`scripts/wiki-lint.ts` added** + `pnpm wiki:lint` wired in `package.json`. Checks frontmatter shape, `covers:` path existence + line-range bounds, `edges:` target existence + type, orphans, staleness (>60d), and drift (covered file modified after `last_verified`). Exits 1 on errors, 0 on warnings.
- **Schema (CLAUDE.md) sharpened.** Confidence levels now have concrete tests, not just descriptions. Lint section rewritten to document what the linter actually checks plus what it can't automate. Added an explicit "bootstrap caveat" — pages dated 2026-05-18 were authored alongside the code; future sessions should treat them as `medium` for trust purposes until they re-verify.
- **Confidence demoted on 6 pages** (high → medium) where my synthesis exceeded the strength of the evidence. They're still useful descriptions, but they're my interpretations of how things work, not externally-verified facts. Demoted:
  - `modules/controller.md`, `modules/query.md`, `modules/forms.md`
  - `flows/query-subscription.md`, `flows/mutation-concurrency.md`
  - `decisions/brand-markers-not-classes.md`
- **WIKI_SPEC.md left unchanged.** It's the abstract pattern doc — solid as-is. The gaps were in my execution of the pattern, not in the pattern itself.

What I considered but didn't change:

- Trimming "redundant" small module pages (emitter, timing, devtools, errors). Re-reading them, each captures one or two non-obvious behaviors (snapshot iteration, skip-first-effect, free-when-no-subscribers, swallow-handler-throw). Removal would lose those.
- Modifying WIKI_SPEC.md to call out the "agent authors both code and wiki" antipattern. The Candidate-Staging section already implies the fix; my CLAUDE.md schema makes it explicit for this repo.

Linter passes cleanly on the current wiki: 37 pages, 0 errors, 0 warnings.

## [2026-05-18 19:30] ingest | Phase 10 — scopes + `@kontsedal/olas-react`

Spec §10.3 + §16 + §20.10 land. Two pieces in one phase, per §22.

What shipped:

- **Scopes in `@kontsedal/olas-core`** — new `packages/core/src/scope.ts` (`defineScope`, `Scope<T>`). `Ctx` gains `provide<T>(scope, value)` and `inject<T>(scope): T`. `ControllerInstance` carries a lazy `scopes: Map<symbol, unknown> | null` and `inject` walks the parent chain. Throws synchronously during construction when no provider + no default. 11 new tests in `packages/core/tests/scope.test.ts` cover: distinct identity, hasDefault flag, shadow semantics, missing-provider error, default fallback, reactive scope value via embedded signal.
- **`@kontsedal/olas-react`** — was empty shell; now ~230 LOC across `context.ts`, `hooks.ts`, `keep-alive.ts`. Built on `useSyncExternalStore`. Public surface matches §20.10 exactly: `OlasProvider`, `useRoot`, `useController` (alias), `use(signal)`, `useQuery(subscription)`, `useField(field)`, `<KeepAlive>`, `useSuspendOnHidden`. `useQuery`/`useField` batch N subscribes into one render trigger via a per-hook version counter. 7 new tests in `packages/react/tests/adapter.test.tsx` cover the four spec-required cases (signal re-render, query invalidation, StrictMode safety, field/`<input>` round-trip) plus provider edge cases.
- **Testing helpers** — `fakeField<T>` and `fakeAsyncState<T>` added to `@kontsedal/olas-core/testing`, per §20.10.

What changed in the wiki:

- `entities/scope.md` (new, high) — Scope<T> shape, resolution algorithm, reactivity story, lifecycle.
- `modules/react.md` (new, high) — public surface, subscription mechanism (incl. skip-first-fire), multi-signal batching pattern, StrictMode behavior, fakes.
- `flows/use-root.md` (new, high) — end-to-end path from `createRoot` through Provider through hooks to DOM. Covers SSR snapshot, concurrent rendering, failure modes.
- `decisions/no-react-adapter-yet.md` — kept for history, marked superseded, `supersedes` edge added (target: modules/react.md).
- `entities/ctx.md` — surface diagram updated to include scopes; "What's NOT yet on Ctx" no longer lists provide/inject; `covers:` line ranges refreshed.
- `overview.md` — package status table updated; test count bumped 187 → 205.
- `index.md` — new pages added to module/entity/flow sections.

Gates: typecheck/lint/test (205 passed)/build green. Wiki lint passes after this ingest.

Unimplemented after Phase 10:
- Phase 13 (devtools extension)
- Phase 14 (polish & docs)
- `ctx.collection` / `ctx.session` / `ctx.lazyChild` (deferred per §20.2 — listed under "What's NOT yet on Ctx" in `entities/ctx.md`).

## [2026-05-18 20:00] ingest | Phase 14 — polish & docs

Spec §22 Phase 14 lands. Scope: docs/READMEs, migration guide, recipes, worked example, TSDoc audit. All gates green (typecheck/lint/test 205/build/wiki:lint).

What shipped (outside the wiki):

- **Top-level `README.md`** — replaced the one-liner with a proper landing page: what Olas is, quick example, package status table, install, commands, links to spec/wiki/migration/recipes.
- **Per-package READMEs** — `packages/{core,react,persist,zod}/README.md`. Each has install, 30-second example, API at a glance, and back-links to spec sections + wiki pages.
- **`MIGRATING.md`** — TanStack Query and Redux Toolkit Rosetta Stones, plus a "from hooks-at-the-top-of-pages" section. Includes a "when NOT to migrate" reality check.
- **`RECIPES.md`** — copy-paste patterns for `useDebounced`, `usePagination`, `useSubmit`, `useInlineEdit`, `useTail`, `useRealtimePatcher`. Documented as user composables (matches spec §16.5's "these are not framework primitives — they're patterns").
- **`examples/user-profile/`** — first worked example. Workspace package wired through pnpm + tsconfig + `pnpm typecheck` (the root typecheck now `--filter`s examples too). Demonstrates: defineQuery + ctx.use, ctx.form + zodValidator (per-field), reactive form-seed via ctx.effect, mutation with optimistic update + automatic rollback via `Snapshot`, augmenting `AmbientDeps`, defineScope, React UI built on `OlasProvider`/`useRoot`/`useQuery`/`useField`.

What changed in the wiki:

- `overview.md` — Phase 14 status added; Phase 13 called out as the only remaining v1 item.
- This `log.md` entry.

TSDoc audit. Touched: `signals/runtime.ts`, `signals/types.ts`, `forms/validators.ts`, `emitter.ts`, `devtools.ts`, `errors.ts`, `query/types.ts`, `query/define.ts`, `query/infinite.ts`, `query/mutation.ts`, `controller/types.ts`. Filled gaps on exported types/functions; left existing TSDoc intact. Many were already documented from earlier phases.

Conventions decided here (for future reference):
- User-facing docs (`README.md`, `MIGRATING.md`, `RECIPES.md`) live at the repo root.
- Internal architecture knowledge stays in `.wiki/`.
- Examples are typechecked but not built or run by CI.

## [2026-05-18 21:10] ingest | Phase 13 — `@kontsedal/olas-devtools` (in-app variant)

Spec §13 ships as an in-app `<DevtoolsPanel>` rather than a browser extension. The same `root.__debug` contract works for either; the extension is a future thin wrapper around the wire format.

What shipped:

- **New `@kontsedal/olas-devtools` package.** Drop-in React panel + lower-level `DevtoolsStore`. Four tabs: Tree (live controller tree from construct/suspend/resume/dispose events), Cache (fetch lifecycle + invalidate/gc), Mutations (run/success/error/rollback), Fields (validation outcomes — runtime not yet emitting these but the rendering is wired). Inline-scoped CSS so it's truly drop-in. Bounded logs (default 100/each); a Clear button empties them but preserves the live tree.
- **Runtime devtools wiring.** Before this phase the runtime emitted only `controller:*` events; the `DebugEvent` union listed `cache:*` / `mutation:*` / `field:*` but nothing fired them. Now wired:
  - `cache:fetch-start / fetch-success / fetch-error` — via a new `EntryEvents` callback bundle that `ClientEntry` constructs from `client.devtools` and passes into `Entry`. The bundle is `undefined` when no devtools, so the cost is one extra constructor field.
  - `cache:invalidated / gc` — `QueryClient.invalidate / invalidateAll / dropEntry`.
  - `mutation:run / success / error / rollback` — `MutationImpl`. Rollback uses a wrapped `Snapshot` so both auto-rollback (supersede/dispose) AND user-driven `snapshot.rollback()` inside `onError` fire the event once per snapshot.
  - `cache:subscribed` and `field:validated` remain spec'd but unwired (would require threading subscriber/field paths into more types — moderate cost, low value vs the visibility we already get).

What changed in the wiki:

- `modules/devtools.md` — refreshed `covers:` to include the new wiring sites; replaced "what's emitted today" status table with the new reality; added a "how events reach the bus" section.
- `modules/devtools-panel.md` (new, high) — covers the package architecture, the virtual-root tree trick, the bounded-log strategy, the four tabs, and what's deliberately NOT included (signal graph, subscription view, time-travel).
- `index.md`, `overview.md` — devtools package added to status table; test count refreshed (205 → 232).
- This log entry.

Tests added: store.test.ts (13), panel.test.tsx (6), core/tests/devtools-events.test.ts (8). The third pins the runtime-emit contract so future refactors trip it before the panel does.

Future stretch (NOT v1-blocking):
- Browser extension wrapping `root.__debug` over `window.postMessage` → content script → background → DevTools panel.
- `cache:subscribed` and `field:validated` emission (low priority).
- Signal dependency graph view (spec §13 mentioned; needs additional plumbing inside `@kontsedal/olas-core/signals`).

## [2026-05-18 22:10] ingest | three new example apps for breadth + testability

Goal: stretch the public API across three intentionally different runnable
apps so the eloquence + testability claim is concrete. Each app has its own
`package.json`, Vite dev/build, vitest config, in-memory api, and unit tests.

What shipped:

- **`examples/_shared/aliases.ts`** — single source of Vite + Vitest source aliases for `@kontsedal/olas-*` packages so apps run without a pre-built `dist/`.
- **`examples/stock-ticker/`** (vanilla TS, no React) — `signal`/`computed`/`effect` DOM bindings, `ctx.emitter` price stream, `debounced`/`throttled`, `defineQuery` + `refetchInterval`, `usePersisted` watchlist. 7 controller tests.
- **`examples/kanban/`** (React + Devtools) — three mutation concurrency modes side by side (`parallel` moveCard with optimistic rollback, `latest-wins` filter, `serial` reorder), `formFromZod` + `FieldArray` for card subtasks, `defineScope` for currentBoardScope, `<DevtoolsPanel>` mounted. 9 tests (7 controller + 2 component using `fakeField`).
- **`examples/reader-ssr/`** (React + SSR) — `waitForIdle → dehydrate → hydrate` round-trip with a paginated `defineQuery` keyed by cursor (the cursor-keyed pattern was forced because `dehydrate` doesn't currently serialize `defineInfiniteQuery` entries — see findings below). `useSuspendOnHidden`, `usePersisted` reading progress, emitter-driven analytics, `onError` root option. 6 tests including the SSR cache-hit contract.
- New wiki page [`modules/examples.md`](modules/examples.md) — covers all four examples, the shared scaffolding, and the findings list. Linked from `index.md`.
- README updated with an Examples section + table.

Findings surfaced while writing these (now filed on the examples wiki page):

1. **Optimistic mutation rollback is not automatic on regular errors** — only on aborts. `mutation.ts:196-208`. The user must call `snapshot.rollback()` in `onError`. The existing `examples/user-profile` README slightly overstates "automatic"; the new kanban controller shows the correct shape.
2. **`root.dehydrate()` does not serialize infinite-query entries** — `client.ts:246-260` only walks `this.maps`, not `this.infiniteMaps`. Workaround: regular `defineQuery` keyed by cursor with a reactive key thunk.
3. **`formFromZod` does not promote array-level `.min(N)` to a FieldArray validator** — `packages/zod/src/index.ts:131-137`. Leaf and nested object rules work; array-level rules silently drop.
4. **`getByLabelText` matches both wrapping `<label>` and `aria-label`** when both are present — use one or the other.

CI status: every example passes its own `typecheck` and `test`. The root `pnpm typecheck` (which globs `examples/*`) is also green. Production builds verified for stock-ticker (60 KB / 14 KB gzip), kanban (276 KB / 77 KB gzip), and reader-ssr (client 202 KB / 60 KB gzip + server bundle).

## [2026-05-19 12:10] ingest | tsup → tsdown; drop ignoreDeprecations

Removed `"ignoreDeprecations": "6.0"` from `tsconfig.base.json`. The previous deps-bump commit added it to silence a deprecated-`baseUrl` warning that tsup injects into its internal DTS-build tsconfig. Instead of carrying that suppression forward (or patching tsup), swapped the bundler for **tsdown** (egoist's rolldown-powered successor to tsup), which doesn't inject the deprecated option.

Mechanical changes:
- 5× `tsup.config.ts` → `tsdown.config.ts`. Same shape, with three renames:
  - `outExtension({ format })` → `outExtensions: ({ format }) => ...` (plural, and `format` is now the rolldown-internal value `"es"` / `"cjs"`, not tsup's `"esm"` / `"cjs"`).
  - `external: [...]` → `deps: { neverBundle: [...] }`.
  - `target: 'es2020'` → `target: 'es2022'` (now matches `tsconfig.base.json`; previously divergent for no reason).
- Each `packages/*/package.json` `build` script: `tsup` → `tsdown`.
- Root `devDependencies`: dropped `tsup`, added `tsdown@^0.22.0` + `unrun@^0.3.0` (the loader tsdown uses to read `.ts` config files — optional peer; without it tsdown refuses to load TS configs).
- tsdown emits **separate `.d.mts` and `.d.cts` files** per output format (no plain `.d.ts`). Updated each package's `exports` to the dual-conditional pattern:
  ```json
  "exports": { ".": {
      "import":  { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
  } }
  ```
  Top-level `"types"` repointed to `.d.cts` (the legacy-resolution fallback path TS uses when it doesn't read `exports`).

Verification: typecheck (8 projects) clean, lint (146 files) clean, 236/236 tests pass, all 5 package builds clean with no warnings.

Pages touched: `decisions/no-react-adapter-yet.md` (mentioned `tsup.config.ts`). README + CLAUDE.md `pnpm build` line updated to reflect new dist shape (`{mjs,cjs,d.mts,d.cts}`).

Wiki-lint after this change reports 1 pre-existing error (`modules/examples.md` covers a deleted `examples/user-profile`) and 67 pre-existing drift warnings (covered files modified by the `09cd034` deps-bump without bumping `last_verified` on the wiki pages). Both predate this change and are out of scope for this ingest.

## [2026-05-19 12:40] ingest | wire refetchOnWindowFocus + refetchOnReconnect

Both flags were declared in `QuerySpec` (spec §5.9) but the runtime ignored them — a pure-types gap a code review flagged. Now wired.

Design:

- New module `packages/core/src/query/focus-online.ts` — lazy single window/document listener per event (`focus` + `visibilitychange` for focus; `online` for reconnect). Lazy install on first subscriber; subscribers form a `Set<() => void>` and the listener fans out. `typeof window === 'undefined'` guard makes it SSR-safe (no-op subscribe/unsubscribe).
- `ClientEntry` (in `client.ts`) stores `refetchOnWindowFocus` / `refetchOnReconnect` from the spec. On the 0→1 subscriber transition (alongside the existing `refetchInterval` start), it subscribes; on release-to-0 and on dispose, it unsubscribes. On event fire, the handler calls `entry.isStaleNow()` first and skips the refetch if the data is still inside `staleTime`. This matches TanStack-style behavior: focus is a *hint*, not an unconditional refetch.

Why a separate module (not inline in `client.ts`):

- The window/document listener is global, not per-client. Putting the registry next to `ClientEntry` would have either created one listener per entry (wasteful and an event-storm risk) or a hidden module-singleton inside `client.ts`. A dedicated file makes the singleton visible and the SSR guard reviewable in isolation.

Coverage:

- 8 new tests in `packages/core/tests/query-focus-online.test.ts` (jsdom env). Cover: focus refetch when stale; skip when fresh (within `staleTime`); default-off behavior when flag is unset; unsubscribe on dispose (event after `root.dispose()` does not refetch); `document.visibilitychange` → `visible` also triggers; reconnect refetch on `online`; both flags coexisting on one query.

Lib test count 236 → 244. Wiki: `entities/query-client.md` covers updated (now includes `focus-online.ts`), `last_verified` bumped, body block on `ClientEntry`'s per-root fields adds an `unsubFocus` / `unsubOnline` entry. Status sentence in CLAUDE.md and the test count in README / `.wiki/overview.md` bumped accordingly.

Spec impact: none — this is implementing already-spec'd behavior. The `RootOptions` root-wide override mentioned by spec §5.9 ("opt-in per query or root-wide") is still not implemented; only per-query opt-in is wired. Filing as a separate follow-up if needed.

## [2026-05-19 12:50] ingest | root-wide refetchOn defaults

Followup to the per-query wiring above. Spec §5.9 narrative said "opt-in per query or root-wide", but the §20.8 `RootOptions` type listing didn't include the fields — a spec typo, since the narrative was authoritative. Fixed both ends in one change:

- **Spec amendment.** Added `refetchOnWindowFocus?: boolean` and `refetchOnReconnect?: boolean` to the `RootOptions` type in §20.8. Pure addition; matches the narrative that's been there since v1 draft.
- **Type + runtime.** Same fields added to `controller/types.ts` `RootOptions`. Plumbed through `createRootWithProps` into `new QueryClient({ ... })`. `QueryClient` stores them as `readonly` defaults. `ClientEntry`'s flag resolution: `spec.flag ?? client.flag ?? false` — per-query spec wins so an explicit `false` on a query opts out even when the root default is `true`.

Test coverage adds (jsdom env):

1. Root `refetchOnWindowFocus: true` applies to a query that doesn't set the flag.
2. Root `refetchOnReconnect: true` likewise.
3. **`spec.refetchOnWindowFocus: false` beats root `refetchOnWindowFocus: true`** — the per-query opt-out is honored.
4. **`spec.refetchOnWindowFocus: true` is honored when root default is unset** — guards against resolution-order regressions.

Lib test count 244 → 248. Status / README / overview counts bumped; the `entities/query-client.md` `unsubFocus`/`unsubOnline` paragraph updated to spell out the precedence rule.


## [2026-05-19 14:58] ingest | @kontsedal/olas-realtime package landed

New workspace package: thin wrappers around the SPEC §16.5 realtime → cache-patches
pattern and the §16.5 tail-buffer pattern. Adds modules/realtime.md (medium
confidence — same-session, per CLAUDE.md bootstrap caveat). Service interface
is consumer-implemented via AmbientDeps augmentation; package ships no default.

- `useRealtimePatcher(ctx, channel, handlers)` — dispatch realtime events by
  `event.type`; handlers wrapped in `untracked(...)` to prevent re-subscribe
  thrash when handlers read signals.
- `useLiveStream<TEvent>(ctx, channel, options?)` — `capacity` oldest-drop,
  `flushMs` coalesced flush, `pause/resume/clear`. Buffer preserved across
  pause; subscription cycled via `ctx.effect` reading `isPaused.value`.

10 new tests (5 patcher, 5 live-stream). vitest alias added; biome / typecheck
/ wiki-lint pass. BACKLOG entry flipped from `[idea]` to `[in-progress]`.

## [2026-05-19 15:50] ingest | @kontsedal/olas-cross-tab package + QueryClientPlugin surface landed

Two-part change: (1) a new pluggable surface on the core `QueryClient`,
(2) `@kontsedal/olas-cross-tab` — the first consumer — as a workspace package. Spec
amendment lands at §13.2 (sibling to §13.1 persist), plus updates to
§5.2, §20.4, §20.8, §20.9.

### Core surface (`packages/core/src/query/plugin.ts`)

New types exported from `@kontsedal/olas-core`:

- `QueryClientPlugin` — `init` / `onSetData` / `onInvalidate` / `onGc` /
  `dispose`. All optional; wrapped in try/catch by `QueryClient`.
- `QueryClientPluginApi` — `applyRemoteSetData(queryId, keyArgs, data)`,
  `applyRemoteInvalidate(queryId, keyArgs)`, `subscribedKeys(queryId)`.
- `SetDataEvent` / `InvalidateEvent` / `GcEvent` — discriminated by
  `kind: 'data' | 'infinite'`. `SetDataEvent` and `InvalidateEvent`
  carry `isRemote: boolean` — `true` when the write came in via
  `applyRemote*`, so plugins know to skip rebroadcast.

`QuerySpec` and `InfiniteQuerySpec` gain two optional fields:
`queryId?: string` (stable identifier used by plugins for routing) and
`crossTab?: boolean` (per-query opt-in). `defineQuery` registers the
query under its `queryId` in a module-level `Map`; a `crossTab: true`
spec without a `queryId` logs a one-time dev warning.

`RootOptions` gains `plugins?: QueryClientPlugin[]`; forwarded into
`new QueryClient({ plugins })`. `ErrorContext.kind` adds `'plugin'`
for plugin-callback exceptions.

`QueryClient.applyRemoteSetData/Invalidate` apply only to entries that
already exist locally (matched by `stableHash(keyArgs)`). Otherwise the
message is dropped silently — without `callArgs` the receiver couldn't
refetch later, and seeding rows the user never subscribed to is leaky.

### `@kontsedal/olas-cross-tab` package

`crossTabPlugin({ channelName, onWarn?, channelFactory? })`. Three echo-
prevention layers: (1) sender-side `isRemote` skip in core, (2) own-
source drop via random `sourceId`, (3) `(sourceId, msgId)` dedup against
out-of-order / duplicate delivery. Non-cloneable payloads trigger
`onWarn` and drop. Channel name versioning is user-supplied — `v` field
on the wire protocol is for protocol-shape evolution.

SSR-safe: when `BroadcastChannel === undefined` and no `channelFactory`
override is supplied, returns a no-op plugin. Roots boot cleanly.

Per-query gate: the plugin checks `crossTab === true` on the spec via
`lookupRegisteredQuery(queryId)` before broadcasting.

### Tests

- `packages/core/tests/plugin.test.ts` — 9 tests pinning the core surface
  (init, onSetData fires + isRemote, anonymous-query skip, apply remote +
  dedup, applyRemote no-op for unknown id, onInvalidate, dispose,
  exception routing, subscribedKeys).
- `packages/cross-tab/tests/plugin.test.ts` — 10 end-to-end tests with a
  fake `BroadcastChannel` bus shared across two `QueryClient`s. Covers
  the plan's tests 1-10 (data sync, no echo, crossTab: false isolation,
  missing-queryId warn, invalidation propagation, non-cloneable warn,
  SSR no-op, dispose teardown, channel-name isolation, msgId dedup).
- `packages/cross-tab/tests/ssr.test.ts` — 2 tests on the no-op-when-
  unsupported path.
- `packages/cross-tab/tests/non-cloneable.test.ts` — 1 test pinning the
  sender-unaffected + onWarn-called behaviour with a structured-clone
  check in the fake channel.

Total: 22 new tests. Lib total 266 → 288.

### Module-graph caveat (test harness)

In real life each tab is its own process, so `Query.__clients` only
contains the local client. In a single-process test harness, two
`createRoot` calls share one `defineQuery` value and `Query.setData(...)`
writes to both clients synchronously — masking the cross-tab path. The
cross-tab test harness mints separate `defineQuery({ queryId: '...' })`
values per "tab" with shared `queryId`s. The registry's "last write wins"
semantics mean the most-recent definition is the routing target — fine
because every tab's `applyRemoteSetData` only applies if the LOCAL
client has an entry, and each tab's local entries are bound against its
own query value. Documented in `modules/cross-tab.md`.

### Wiki & SPEC

- New `modules/cross-tab.md` (medium — same-session, per CLAUDE.md
  bootstrap caveat).
- `modules/query.md` — added `plugin.ts` to covers; new "Plugin slot"
  body section; `last_verified` bumped.
- `entities/query-client.md` — added `plugin.ts` to covers; new "Plugins"
  body section; confidence demoted high → medium because of the new
  same-session synthesis.
- `index.md` — module entry for cross-tab.
- SPEC §13.2 added (sibling to §13.1 persist). §5.2 example QuerySpec
  gains the two new fields. §20.4 type definitions for `QuerySpec` and
  `InfiniteQuerySpec` updated. §20.8 adds `plugins?`, plus the
  `QueryClientPlugin` / `QueryClientPluginApi` / `SetDataEvent` /
  `InvalidateEvent` / `GcEvent` type listings. §20.9 `ErrorContext.kind`
  adds `'plugin'`.

### Gates

typecheck (10 projects, packages + examples) clean. Biome check clean.
288/288 tests pass. All 6 package builds clean. BACKLOG flipped from
`[idea]` to `[in-progress]`.

## [2026-05-22 13:55] lint | docs sweep — re-verify after 0.0.7→0.0.15

Whole-repo doc pass triggered by drift after today's release batch
(0.0.7 → 0.0.15) and the `packages/integration` cross-package suite landing.

### Top-level docs

- `README.md` — package count 8→10 (added `mutation-queue`, `router`),
  test count "436 / 37 files" → "621 / 55 files", Install snippet expanded.
- `CLAUDE.md` — `Read this first` package-status paragraph rewritten;
  workspace-layout block now lists all ten published packages plus the
  private `integration/` suite; test counts refreshed.
- `packages/mutation-queue/README.md` — authored (was missing).
- `packages/router/README.md` — authored (was missing).
- `packages/entities/README.md` — Constraints (v1) line that claimed
  "infinite queries are not walked" was stale; the plugin DOES walk
  infinite payloads (confirmed by `tests/entities.test.ts:1012`). Fixed
  the README and the matching stale header comment in
  `packages/entities/src/index.ts:305-310`.

### Wiki pages — explicit verification

Read the covered code and confirmed claims still hold; `last_verified`
bumped to 2026-05-22 on:
- `overview.md` — also fixed package list + IDB adapter + test counts.
- `modules/query.md` — fixed broken citation (`client.ts:808-819` was
  `dehydrate`, not the hydrated-bind path); now cites `client.ts:894-895`
  and `:927-928` correctly. Streaming SSR pointer added.
- `modules/react.md` — public-surface block was missing 9 new exports
  (`createOlasContext`, `HydrationBoundary`, `useFieldInput`,
  `useMutation`, `useSuspenseQuery`, `useFieldInput`, plus all of
  `streaming.ts`). Rewritten.
- `modules/forms.md`, `modules/controller.md`, `modules/persist.md`,
  `modules/realtime.md`, `modules/entities.md` — read against code; no
  drift; bumped.
- `flows/ssr.md` — added a "Streaming SSR (v0.0.14+)" section covering
  `createStreamingHydrator` / `createStreamingTransform` /
  `OLAS_BOOTSTRAP_SCRIPT` / `HydrationBoundary`.
- `flows/construction-rollback.md`, `flows/query-subscription.md`,
  `flows/use-root.md` — read; no drift; bumped.
- `entities/entry.md`, `entities/query-client.md`,
  `entities/controller-instance.md`, `entities/scope.md` — read; no drift;
  bumped.
- `decisions/{brand-markers-not-classes,per-root-query-client,
  signals-runtime-wrapped,no-react-adapter-yet}.md` — conceptual content
  unchanged; bumped.
- `pitfalls/{field-value-shape,isstale-needs-timer,literal-type-narrowing,
  fieldarray-factory-uses-initial,preact-signals-overload-return}.md` —
  read; no drift; bumped.
- `pitfalls/callargs-vs-keyargs.md` — line-range citations were stale
  (`31-102 + 214-265` → corrected to `31-222 + 881-960`). Code example
  showed the old `fetcher(args, signal)` shape; updated to current
  `fetcher({ signal, deps }, ...callArgs)` form.

### Wiki pages — limited verification

Bumped `last_verified` but `confidence` left at or below `medium` because
direct read of body claims was lighter-touch than the pages above. Future
sessions should treat these as candidates for re-verification:
- `modules/cross-tab.md`
- `modules/devtools.md`
- `modules/devtools-panel.md`

The Explore audit agent's earlier "clean" verdict for these pages was
spot-trusted (it correctly flagged the drift on `modules/react.md` and
`pitfalls/callargs-vs-keyargs.md`, so its negative findings have some
signal), but body-level claims were not re-derived from source in this
session.

### Gates

`pnpm wiki:lint` → 45 pages scanned · 0 error · 0 warning.
`pnpm test` → 621/621 pass across 55 files.

## [2026-07-25 11:15] ingest | REMEDIATION.md phases 0–1

Deep-audit remediation (see `REMEDIATION.md`), phases 0 (infra) and 1 (query criticals).

- **T0.1** — `scripts/wiki-lint.ts` was blind on a CRLF (Windows) checkout: LF-only frontmatter regex + backslash path comparisons made every page read as frontmatter-less. Fixed both; the linter now surfaces real staleness/drift (previously masked). Note: bootstrap pages are broadly stale (>60d) — resolved per-phase as their covered code is re-verified, not by a blanket bump.
- **T1.1** — `Entry.setData` / `InfiniteEntry.setData` gained a `track` option. Plugin/remote canonical writes (`applyRemoteSetData`, `setEntryData`) no longer push optimistic snapshots or wedge `hasPendingMutations`. Updated `entities/entry.md`, SPEC §6.4/§13.2. Pinned by `regressions.test.ts` R-Q1.1.
- **T1.2** — SSR hydration namespaced by query identity (`__id = queryId ?? auto`) not key-hash, killing cross-query data theft. Updated `flows/ssr.md`, SPEC §15. Pinned by R-Q1.2.

### Gates

`pnpm typecheck` clean; `pnpm lint` (biome, LF) clean; `pnpm test` → 626/626 across 55 files.

## [2026-07-25 12:06] ingest | REMEDIATION.md phase 2 (core lifecycle)

Phase 2 — controller/query lifecycle criticals + majors + minor batch.

- **T2.1** — `ctx.use` binding effect reads enabled/key BEFORE the `suspended` early-return, so a key change during suspension can't empty its deps. New pitfall `suspended-effects-lose-deps.md`; `flows/query-subscription.md`.
- **T2.2** — `resume()` skips re-activating an effect whose `dispose` is already live (registered mid-resume). `entities/controller-instance.md`.
- **T2.3** — `ctx.collection` reconcile untracks everything but `source.value`. `modules/controller.md`.
- **T2.4** — every `ctx.*` factory throws after dispose (`assertLive`); `ctx.effect` no longer silently no-ops. SPEC §4; `entities/ctx.md` (covers range refreshed to `instance.ts:390-1130`).
- **T2.5** — root-controls name-conflict throw now disposes instance + queryClient. (no doc page)
- **T2.6** — `explicitlySuspended` flag on the child entry; explicit suspension survives tree cascade. SPEC §4.1; `controller-instance.md`; suspendItem contract.
- **T2.7** — `debounced`/`throttled` gain `dispose()`, a read-only handle, trailing:false fixes, both-false validation. `modules/timing.md`; API.md.
- **T2.8** — emitter docstring, readOnly on collection/lazyChild signals, rollback + effect-cleanup error routing, `createRoot<Api extends object>`. pathKey was could-not-reproduce (already joins with NUL).

Regression tests R-L2.1…R-L2.8 (+ R-Q1.1/1.2 from phase 1) all under `packages/core/tests/regressions.test.ts` and the timing options matrix in `timing.test.ts`.

### Gates

`pnpm typecheck` clean (after `pnpm build` — satellites resolve core via dist; see BACKLOG); `pnpm lint` clean; `pnpm test` → 649/649 across 55 files.

## [2026-07-25 14:25] ingest | REMEDIATION.md phase 3 (query cache majors)

Phase 3 — query cache majors + a 10-item minor batch (`packages/core/src/query/`, `packages/react/src/streaming.ts`).

- **T3.1** — out-of-order optimistic rollback **chain-splices** instead of blindly restoring `record.prev`; rolling back every layer in any order returns to the pre-mutation baseline. `Entry` + `InfiniteEntry`. SPEC §6.4; `entities/entry.md`. Full updater-replay rebasing → BACKLOG.
- **T3.2** — `refetchInterval` **joins** an in-flight fetch (`isFetching.peek()`) instead of aborting it (was a livelock when fetch > interval). Both interval sites. `entities/query-client.md`.
- **T3.3** — infinite `fetchNextPage`/`fetchPreviousPage` onSuccess now set `status:'success'`; `runFetch` finally repairs a wedged `'pending'`. Un-wedges Suspense after paging over a mid-flight refetch.
- **T3.4** — new `query.cancel` / `cancelAll` + `subscription.cancel` (+ infinite parity), backed by `Entry.cancel` / `InfiniteEntry.cancel`; `applySuccess` rebases live snapshots onto server truth so a later rollback can't resurrect pre-fetch data. SPEC §5.5/§6.4; API.md; README optimistic recipe.
- **T3.5** — `networkMode:'offlineFirst'` parks a fetch-`TypeError`-while-offline and retries on reconnect; new **`isPaused`** signal on `AsyncState` (added to every producer — Entry/InfiniteEntry/both subs/LocalCache/fakeAsyncState). SPEC §5.3/§5.5; API.md.
- **T3.6** — optimistic `snapshot.rollback()` re-emits a `SetDataEvent` (guarded on an actual data change) so cross-tab / entity peers drop failed optimistic state. `entities/query-client.md`.
- **T3.7** — infinite refetch re-fetches **all** loaded pages (`runRefetchAll`), not collapse-to-page-one; atomic update, no truncation flash. SPEC §5.7. Infinite SSR dehydrate deferred → BACKLOG + SPEC §15 + react README.
- **T3.8** — `stableHash` reads the raw holder property (`this[key]`) so Date tagging + the class-instance throw aren't dead code (`toJSON` runs before the replacer).
- **T3.9** (commits a–e2) — onMutate-throw aborts the run; `subscription.refetch()` resolves (not AbortError-rejects) on supersede; exponential retry-backoff default; `dispose()` resets `isFetching`; focus/visibilitychange debounce + isFetching join; `invalidate` marks-stale-only when subscriber-less (`markStale`/`forcedStale` + `client.invalidateEntry`); query + mutation registries shared on `globalThis` (dual-package hazard); duplicate `queryId` dev-warn; `_unregisterMutationById` moved to `/testing`; streaming `flush()` skips un-serializable entries.

New public surface: `Query.cancel` / `cancelAll`, `subscription.cancel`, `AsyncState.isPaused`. New `Entry`/`InfiniteEntry` methods: `cancel`, `markStale`. Regression tests R-Q3.1…R-Q3.9 in `regressions.test.ts` (+ `stableHash` cases in `query.test.ts`; offlineFirst / focus-double-fire in `query-focus-online.test.ts`; streaming guard in react `streaming.test.tsx`).

### Gates

`pnpm build` + `pnpm typecheck` clean (all packages + examples); `pnpm exec biome lint .` clean (273 files); `pnpm test` → 673/673 across 55 files.

## [2026-07-25 15:54] ingest | REMEDIATION.md phase 4 (React adapter)

Phase 4 — `packages/react/src/` (context, hooks, keep-alive, streaming).

- **T4.1** — `HydrationBoundary` owns its root via ref+effect, not `useMemo` (which StrictMode double-invoked → orphaned live root; inline `options` recreated every render; never disposed). Lazy create-in-render (ref-deduped), options read once, def-change recreate, dispose on unmount; empirically confirmed StrictMode does NOT re-render after its effect remount, so the effect recreates + `forceRender()`s to keep one live root. New `hydration-boundary.test.tsx`. `modules/react.md`.
- **T4.2** — added `Mutation.status` signal (core `mutation.ts`); `useMutation`'s `isSuccess`/`isIdle`/`isError` derive from it, so a **`void` mutation** reports success (the old `data !== undefined` heuristic left it stuck idle). A superseded latest-wins run doesn't flip status. SPEC §6; API.md; `entities/mutation.md` (last_verified bumped).
- **T4.3** — `useSuspenseQuery` throws to the ErrorBoundary only when there's **no data** — a background-refetch failure keeps the last-good data rendered (was nuking the subtree on a blip).
- **T4.4** — `use(signal, { select })` re-derives when the **selector identity** changes (was returning the previous selector's slice when raw was unchanged). First `isEqual` coverage.
- **T4.5** — replaced the version-counter `getSnapshot` (which defeated uSES's mount-consistency check — a write between render and subscription was invisible) with a memoized core **`computed` snapshot** whose `.value` reflects real store state. All four multi-signal hooks (`useQuery`/`useField`/`useFieldInput`/`useMutation`). `modules/react.md` rewritten.
- **T4.6** — `SuspendOnUnmount`/`KeepAlive` **refcounted** across overlapping wrappers (module-level WeakMap): `resume` on 0→1, `suspend` on 1→0, so a cross-fade can't suspend a controller the entering screen still uses. Isomorphic `useLayoutEffect`. `modules/react.md`.
- **T4.7** (2 commits) — dropped `aria-errormessage` (ARIA wants an ID ref, not text); `useFieldInput` transform-in-ref so handlers memo on `[field]`; fixed reset/suspense docstrings; streaming docstring passes the plugin through `HydrationBoundary` options; teardown re-installs a **queue** (not an inert sink) so late stream entries aren't dropped; `context.ts` `options as any` → `RootOptions`. `[?]` disabled+suspense guard: an idle-no-data sub is indistinguishable from one torn down at dispose (teardown false-positives + React-19 `uncaughtError`) — reverted; limitation in BACKLOG.

New public surface: `Mutation.status`. Tests in `packages/react/tests/*` (hydration-boundary, adapter, suspense, keep-alive, streaming).

### Gates

`pnpm build` + `pnpm typecheck` clean (all packages + examples); `pnpm exec biome lint .` clean (274 files); `pnpm test` → 689/689 across 56 files.

## [2026-07-25 16:47] ingest | REMEDIATION.md phase 5 (forms)

Phase 5 — `packages/core/src/forms/` (field, form, validators). Three commits.

- **T5.1** — `FieldArray` tracks **structural dirtiness** (`structurallyDirty$`, flipped by `add`/`insert`/`remove`/`move`/`clear`, reset by `reset()` / `replaceInitialItems`). `isDirty = structural || anyItemDirty`. Before this, a reactive `initial: () => queryData` + default `resetOnInitialChange: 'when-clean'` re-seated the array on a background refetch and silently **deleted rows the user just added**. Pinned `R-F5.1`. SPEC §8.5; `modules/forms.md`.
- **T5.2** — form-/array-level validators can **target specific fields**. `Validator<T>` widened to also return `FormIssue[]` (`{ path, message }`); `runTopLevelValidators` collects issues (`appendIssues`) and `routeFormIssues(this, …)` routes empty-path → the node's `topLevelErrors`, path → `resolveNode`'s descendant via `setFormErrors`. Fields gain a **third error channel** `formErrors$` (merged into `errors`); Form/FieldArray merge parent-injected errors into `topLevelErrors` (now a computed) + `isValid`. Cleared/re-applied each run (`lastFormErrorTargets`). Standard-Schema `validator()` rewritten to return **all** issues as `FormIssue[]` with paths; `zodValidator` inherits it. `debouncedValidator` narrowed to a precise `string | null` return so direct callers still type-check. Pinned `R-F5.2` + `standard-schema.test.ts`. SPEC §8.1/§8.3/§20.7; API.md; `modules/forms.md` + `zod.md`. BACKLOG: formFromZod root `.refine({path})` routing.
- **T5.3** — minor batch: `validateOn: 'blur'|'submit'` now tested (were zero); `dirtyFields`/`clearSubtree` tested; `required(false)` now **passes** (a boolean is a legit value) + new **`mustBeTrue`** validator for consent checkboxes; `isValid` **holds last-known validity while `isValidating`** (`lastValid$`) so a `debouncedValidator` no longer strobes a submit button (replaces the old "invalid-while-validating" rule — SPEC §8.2 + docstring updated); `Form.reset()` re-applies initial **inside** the batch (no tearing); thrown-validator messages are **generic in prod** (`'Validation failed'`, real error still routed via `onValidatorError`), dev keeps the message. New tests in `form.test.ts` + `validators.test.ts`; `controller.test.ts` isValid-while-pending assertion updated.

New public surface: `FormIssue` / `ValidatorResult` types, `mustBeTrue` validator. `Validator<T>` return widened.

### Gates

`pnpm build` + `pnpm typecheck` clean (all packages + examples); `pnpm exec biome lint .` clean (274 files); `pnpm test` → 708/708 across 56 files; `pnpm wiki:lint` 0 errors.

## [2026-07-25 22:57] ingest | REMEDIATION.md phase 6 (satellite packages)

Phase 6 — the seven satellite packages. Seven commits (`9cc9934` persist →
`601edb6` realtime). T6.3–T6.6 were executed by `fork` subagents (inherit full
context → same test-first workflow + commit conventions) and independently
gate-verified; T6.1/T6.2/T6.7 done directly.

- **T6.1 persist** (`9cc9934`) — IndexedDB adapter now resolves on the
  transaction's `oncomplete` (not `req.onsuccess`) so quota/commit failures
  surface + REJECT (were swallowed); `onversionchange` closes the connection so
  a stale one can't block another tab's upgrade. usePersisted: `flushWrite`
  splits serialize-vs-write op labels; a user write before an async load settles
  now WINS over the stored value (and a racing cross-tab change is buffered)
  instead of being dropped + clobbered by `applyLoaded`. +17 tests for the
  previously-untested version/migrate/throttleMs/onError surface (fake IDB made
  transaction-aware).
- **T6.2 mutation-queue** (`e13ac13`) — the three disqualifiers: reconnect
  replay (`online` listener + `replayNow()`, one guarded `runReplay`), cross-tab
  coordination (`withReplayLock`: Web Locks `ifAvailable` + best-effort
  localStorage-lease fallback), and `onReplaySettle(entry,result,api)` cache
  reconciliation. Honesty: `seqCounter=Date.now()` (kills the priming race),
  dedupe key cleared only on entry-drop (not cancel/non-terminal error → no
  double-write), README demoted to **best-effort**. +11 tests + new
  `.wiki/modules/mutation-queue.md`. BACKLOG: cross-mutationId causal ordering.
- **T6.3 devtools** (`c4eb61e`) — JsonView cycle guard is now an immutable
  ancestors-only `ReadonlySet` per level (a DAG `{a:obj,b:obj}` / collapse→expand
  / StrictMode no longer false-flag `[Circular]`; true cycles still caught);
  `store.ts` prunes disposed subtrees past `maxDisposedNodes` (default 200) +
  FIFO mutation-start queue per `path#name` (the debug bus has no per-run id — a
  real runId would be a core change, noted); 150ms-debounced panel filter.
- **T6.4 cross-tab** (`98e7038`) — removed the dead `crossTab: 'infinite'|'both'`
  values (narrowed the core `QuerySpec.crossTab` type to `boolean|'data'`;
  dev-warn + degrade-to-`'data'` for JS callers); the receive path now applies
  the same `shouldBroadcast` filter as send; README documents the honest
  last-delivery-wins conflict model. BACKLOG: infinite cross-tab.
- **T6.5 zod** (`8cc13f0`) — `zodValidatorAsync` removes the abort listener in
  `finally` + swallows the losing race promise (no unhandled rejection / leaked
  listener); `isForeignZod`/`warnDuplicateZod` dev-warn on a duplicate-zod-copy
  schema; `ZodDate` default → `undefined` (was `null` into a Date field),
  `.transform()`/`.pipe()` seeds from the INPUT schema, unions → `undefined`;
  fixed the stale "3.x/4.x" comment (peer is `^4.0.0`).
- **T6.6 router** (`a3cebd4`) — `createRouterAdapter(initial?: RouteState)` seeds
  route signals for the effect-less server render (SSR hole); Bridge push
  `useEffect` → `useLayoutEffect`; `params` widened to
  `Record<string, string | undefined>`. README documents server seeding + the
  first-render-empty footgun + the `enabled`-guard pattern. (Router still has no
  wiki page — left for the T7.3 sweep.)
- **T6.7 realtime** (`601edb6`) — `useRealtimeConnection` reports `'unknown'`
  (added to `ConnectionState`) when the transport has no `onConnectionChange`
  instead of lying `'connected'`; clarified everywhere that events arriving
  DURING a `pause()` are LOST (subscription torn down) — recover via
  `onReconnect` + invalidate.

New/changed public surface: persist `version`/`migrate`/`throttleMs`/`onError`
(documented + tested), mutation-queue `onReplaySettle` + `replayNow()`, devtools
`maxDisposedNodes`, cross-tab `crossTab` narrowed to `boolean|'data'`, zod
`isForeignZod` warning, router `createRouterAdapter(initial?)` + widened
`params`, realtime `ConnectionState` gains `'unknown'`.

### Gates

`pnpm build` + `pnpm typecheck` clean (all packages + examples); `pnpm exec biome
lint .` clean (275 files); `pnpm test` → 751/751 across 57 files; `pnpm wiki:lint`
0 errors.

## [2026-07-25 23:48] ingest | REMEDIATION.md phase 7 (delivery, docs, release) — publish deferred

Phase 7 — delivery/docs/release. Three commits (`ba0b9cb`, `2800e1a`, `e6b0c94`),
all executed by `fork` subagents + independently gate-verified. **No publish /
version bump / tag / push** — the actual `npm publish` is deferred to the
maintainer (outward-facing, needs authorization); T7.1's Publish sub-item stays
`[ ]` on purpose.

- **T7.1 release prep** (`ba0b9cb`) — fixed the stale `# @olas/*` CHANGELOG
  headers → `@kontsedal/*`; back-filled a consolidated 0.0.7–0.0.15 block per
  package (honestly flagged as bumped-but-never-published — npm froze at 0.0.6);
  a `patch` changeset for the remediation across all 10 published packages; a
  `main`-only, `NPM_TOKEN`-gated `.github/workflows/release.yml` (changesets/
  action — can't fire by accident without the secret). No `changeset version`.
- **T7.2 verify what you ship** (`2800e1a`) — `publint` + `@arethetypeswrong/cli`
  per package in CI (both already clean — only finding was the missing
  `engines`, now added: `node >=18` on all 10 published packages); a zero-dep
  dist smoke test (`scripts/verify-dist.mjs`, `pnpm smoke:dist`: ESM import + CJS
  require each built entry + a `__DEV__`-leak grep — none leaks, tsdown defines
  it correctly); coverage thresholds in `vitest.config.ts` seeded just below
  current (~83/71/86/87 → 80/68/82/83) with CI on `pnpm test:coverage`.
- **T7.3 documentation debt** (`e6b0c94`) — API.md brought current from ~0.0.4:
  new `@kontsedal/olas-mutation-queue` + `@kontsedal/olas-router` sections,
  `ctx.session`/`collection`/`lazyChild`, `indexedDbAdapter` + persist
  `version`/`migrate`/`throttleMs`/`onError`, and a **fix to the wrong
  `StorageAdapter` shape** (`remove`/`subscribe` → `delete`/`onChange`/`keys`);
  realtime/cross-tab additions; README de-stale ("~230 lines", mutation-queue
  "Durable"→"Best-effort"); realtime/persist package.json descriptions fixed
  (`defineLiveStream`→`useLiveStream`; persist mentions IDB); `regressions.test.ts`
  off the nonexistent `ASSESSMENT.md`; `query.test.ts` flush hardened + convention
  documented; new **`.wiki/modules/router.md`** (the package had no page). Two
  honest deviations (both `[x]` w/ notes): `query.test.ts` kept its `flush` (not a
  blanket `vi.waitFor` — many sites are negative "did-NOT-happen" assertions), and
  the `last_verified` sweep was NOT blanket-bumped (re-verifying ~30 core/react
  pages honestly is its own pass; false "verified" dates are worse than staleness
  warnings).

Also this session, at the user's request (`6ef3872`): a **candidate backlog**
(`.wiki/candidates/backlog.md` + `candidates/decisions/devtools-overhaul.md`)
rescued the Phase-8 devtools-overhaul vision out of the transient REMEDIATION.md
so it survives that file's deletion, and spotlighted the other substantial
proposals (`olas-offline`, infinite-query completeness, updater-replay rebasing,
devtools extension, ecosystem adapters).

### State

Phases 0–7 complete (43 tasks). Remaining, both intentionally deferred: the
`npm publish` (maintainer-gated) and **Phase 8** (devtools overhaul — a large
additive feature, captured in `.wiki/candidates/`). REMEDIATION.md is NOT
deleted yet (Publish + all of Phase 8 are still `[ ]`).

### Gates

`pnpm build` + `pnpm typecheck` clean (all packages + examples); `pnpm exec biome
lint .` clean (276 files); `pnpm test` → 751/751 across 57 files (coverage gate
green); `pnpm wiki:lint` 0 errors (50 pages).

---

## [2026-07-28 20:45] ingest | devtools overhaul — T8.1 (event backbone) + T8.4 (causal timeline)

Landed the foundation + headline of the Phase 8 devtools overhaul (was
`candidates/decisions/devtools-overhaul.md`).

**Core (T8.1).** `DebugEvent` now carries optional `seq` / `t` / `causeId`
(distributive `Body & Meta`, so `switch` still narrows); `DevtoolsEmitter.emit`
+ replay stamp `seq`/`t` centrally. New events: `cache:set-data`
(`source` + post-write `data`) and `snapshot:push`/`rollback`/`finalize`. A
dev-only ambient cause (`__runWithCause` / `__currentCauseId`) threads a
mutation's `runId` into the optimistic writes + snapshot events it triggers;
fetches share a per-fetch `fetchId`. Wired in `entry.ts` (new `EntryEvents`
hooks + `globalFetchSeq`), `client.ts` (`emitDevtoolsSetData` + the events
bundle), `mutation.ts` (runId → `emit(…, causeId)` + `__runWithCause`).

**Devtools (T8.4).** Store grew `events$` (unified bounded timeline) +
`cacheState$` (event-driven inspector — the 800ms poll is gone; seeded from
`queryEntries()` on attach + refreshed on cache events). New `diff.ts`
(cycle-safe structural before/after). Panel: default **Timeline** tab with
`causeId` cause-chains + per-`set-data` diff; Inspector reads `cacheState$`.

**Docs.** SPEC §14 rewritten (event families + correlation fields). Updated
`modules/devtools.md`, `modules/devtools-panel.md`; new
`flows/devtools-causal-timeline.md`. Candidate overhaul + backlog annotated
with what landed vs. what remains (T8.2/8.3/8.5–8.10 + `cache:subscribed`
wiring + infinite-query devtools events).

### Gates

`pnpm test` → 783/783 across 58 files; `pnpm build` + `pnpm typecheck` clean
(all packages + examples); `biome check --write` on touched files (format +
imports) then `biome lint` clean.

---

## [2026-07-28 21:40] ingest | live verification of the devtools panel — found + fixed a real rAF bug

Ran the kanban example end-to-end in a real browser (Playwright driving system
Edge) to screenshot the live causal Timeline. The Timeline, cause-chain
grouping (createCard run→success; a fetch's start→success→set-data sharing one
causeId with +Δms deltas), and the set-data source/diff all render correctly.

**Bug found (pre-existing, only reproducible in a real browser):** the panel's
`coalesce: 'raf'` path assigned native `requestAnimationFrame` UNBOUND to
`this.schedule`; calling `this.schedule(fn)` invoked rAF with `this === store`
→ `TypeError: Illegal invocation`, swallowed by `DevtoolsEmitter.emit`'s empty
catch, leaving `flushHandle` stuck at `-1`. Effect: Tree + Inspector (set
synchronously) worked, but every coalesced signal (cache / mutations / fields /
timeline) stayed permanently empty with no console error. jsdom's rAF ignores
`this`, so the whole RTL suite passed. Fixed by wrapping rAF/cancelRAF in arrows
(`store.ts`); added a regression test that installs a strict `this`-checking rAF
under vitest; documented in `pitfalls/raf-unbound-illegal-invocation.md`.

### Gates

`pnpm test` → 788/788 across 58 files; `pnpm build` + `pnpm typecheck` clean
(all packages + examples); `biome` clean.
