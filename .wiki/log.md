# Wiki log

Chronological, append-only record of wiki activity. Greppable. Newest at the bottom.

Format: `## [YYYY-MM-DD HH:MM] <kind> | <short summary>` where `<kind>` ∈ {ingest, lint, candidate-promote, contradict, query-archive, schema-change, refine}.

---

## [2026-05-18 17:55] ingest | bootstrap

Initial wiki creation. Authored the schema (`../CLAUDE.md`), `index.md`, `overview.md`, `glossary.md`, and the first round of modules, entities, flows, decisions and pitfalls.

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
- **Schema (CLAUDE.md) sharpened.** Confidence levels now have concrete tests, not only descriptions. Lint section rewritten to document what the linter checks plus what it can't automate. Added an explicit "bootstrap caveat" — pages dated 2026-05-18 were authored alongside the code; future sessions should treat them as `medium` for trust purposes until they re-verify.
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
- `ctx.collection`, `ctx.session` and `ctx.lazyChild` (deferred per §20.2 — listed under "What's NOT yet on Ctx" in `entities/ctx.md`).

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

- **New `@kontsedal/olas-devtools` package.** Drop-in React panel + lower-level `DevtoolsStore`. Four tabs: Tree (live controller tree from construct/suspend/resume/dispose events), Cache (fetch lifecycle + invalidate/gc), Mutations (run/success/error/rollback), Fields (validation outcomes — runtime not yet emitting these but the rendering is wired). Inline-scoped CSS so it's drop-in. Bounded logs (default 100/each); a Clear button empties them but preserves the live tree.
- **Runtime devtools wiring.** Before this phase the runtime emitted only `controller:*` events; the `DebugEvent` union listed `cache:*`, `mutation:*` and `field:*` but nothing fired them. Now wired:
  - `cache:fetch-start, fetch-success and fetch-error` — via a new `EntryEvents` callback bundle that `ClientEntry` constructs from `client.devtools` and passes into `Entry`. The bundle is `undefined` when no devtools, so the cost is one extra constructor field.
  - `cache:invalidated and gc` — `QueryClient.invalidate, invalidateAll and dropEntry`.
  - `mutation:run, success, error and rollback` — `MutationImpl`. Rollback uses a wrapped `Snapshot` so both auto-rollback (supersede/dispose) AND user-driven `snapshot.rollback()` inside `onError` fire the event once per snapshot.
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

CI status: every example passes its own `typecheck` and `test`. The root `pnpm typecheck` (which globs `examples/*`) is also green. Production builds verified for stock-ticker (60 KB, 14 KB gzipped), kanban (276 KB, 77 KB gzipped), and reader-ssr (client 202 KB, 60 KB gzipped, plus the server bundle).

## [2026-05-19 12:10] ingest | tsup → tsdown; drop ignoreDeprecations

Removed `"ignoreDeprecations": "6.0"` from `tsconfig.base.json`. The previous deps-bump commit added it to silence a deprecated-`baseUrl` warning that tsup injects into its internal DTS-build tsconfig. Instead of carrying that suppression forward (or patching tsup), swapped the bundler for **tsdown** (egoist's rolldown-powered successor to tsup), which doesn't inject the deprecated option.

Mechanical changes:
- 5× `tsup.config.ts` → `tsdown.config.ts`. Same shape, with three renames:
  - `outExtension({ format })` → `outExtensions: ({ format }) => ...` (plural, and `format` is now the rolldown-internal value `"es"` and `"cjs"`, not tsup's `"esm"` and `"cjs"`).
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
- `ClientEntry` (in `client.ts`) stores `refetchOnWindowFocus` and `refetchOnReconnect` from the spec. On the 0→1 subscriber transition (alongside the existing `refetchInterval` start), it subscribes; on release-to-0 and on dispose, it unsubscribes. On event fire, the handler calls `entry.isStaleNow()` first and skips the refetch if the data is still inside `staleTime`. This matches TanStack-style behavior: focus is a *hint*, not an unconditional refetch.

Why a separate module (not inline in `client.ts`):

- The window/document listener is global, not per-client. Putting the registry next to `ClientEntry` would have either created one listener per entry (wasteful and an event-storm risk) or a hidden module-singleton inside `client.ts`. A dedicated file makes the singleton visible and the SSR guard reviewable in isolation.

Coverage:

- 8 new tests in `packages/core/tests/query-focus-online.test.ts` (jsdom env). Cover: focus refetch when stale; skip when fresh (within `staleTime`); default-off behavior when flag is unset; unsubscribe on dispose (event after `root.dispose()` does not refetch); `document.visibilitychange` → `visible` also triggers; reconnect refetch on `online`; both flags coexisting on one query.

Lib test count 236 → 244. Wiki: `entities/query-client.md` covers updated (now includes `focus-online.ts`), `last_verified` bumped, body block on `ClientEntry`'s per-root fields adds an `unsubFocus` and `unsubOnline` entry. Status sentence in CLAUDE.md and the test count in README and `.wiki/overview.md` bumped accordingly.

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

Lib test count 244 → 248. Status, README and overview counts bumped; the `entities/query-client.md` `unsubFocus`/`unsubOnline` paragraph updated to spell out the precedence rule.


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

10 new tests (5 patcher, 5 live-stream). vitest alias added; biome and typecheck
/ wiki-lint pass. BACKLOG entry flipped from `[idea]` to `[in-progress]`.

## [2026-05-19 15:50] ingest | @kontsedal/olas-cross-tab package + QueryClientPlugin surface landed

Two-part change: (1) a new pluggable surface on the core `QueryClient`,
(2) `@kontsedal/olas-cross-tab` — the first consumer — as a workspace package. Spec
amendment lands at §13.2 (sibling to §13.1 persist), plus updates to
§5.2, §20.4, §20.8, §20.9.

### Core surface (`packages/core/src/query/plugin.ts`)

New types exported from `@kontsedal/olas-core`:

- `QueryClientPlugin` — `init`, `onSetData`, `onInvalidate`, `onGc` and
  `dispose`. All optional; wrapped in try/catch by `QueryClient`.
- `QueryClientPluginApi` — `applyRemoteSetData(queryId, keyArgs, data)`,
  `applyRemoteInvalidate(queryId, keyArgs)`, `subscribedKeys(queryId)`.
- `SetDataEvent`, `InvalidateEvent` and `GcEvent` — discriminated by
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
out-of-order and duplicate delivery. Non-cloneable payloads trigger
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
  `QueryClientPlugin`, `QueryClientPluginApi`, `SetDataEvent`,
  `InvalidateEvent` and `GcEvent` type listings. §20.9 `ErrorContext.kind`
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
  test count "436 and 37 files" → "621 and 55 files", Install snippet expanded.
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
  `createStreamingHydrator`, `createStreamingTransform`,
  `OLAS_BOOTSTRAP_SCRIPT` and `HydrationBoundary`.
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
- **T1.1** — `Entry.setData` and `InfiniteEntry.setData` gained a `track` option. Plugin/remote canonical writes (`applyRemoteSetData`, `setEntryData`) no longer push optimistic snapshots or wedge `hasPendingMutations`. Updated `entities/entry.md`, SPEC §6.4/§13.2. Pinned by `regressions.test.ts` R-Q1.1.
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
- **T3.4** — new `query.cancel` and `cancelAll` + `subscription.cancel` (+ infinite parity), backed by `Entry.cancel` and `InfiniteEntry.cancel`; `applySuccess` rebases live snapshots onto server truth so a later rollback can't resurrect pre-fetch data. SPEC §5.5/§6.4; API.md; README optimistic recipe.
- **T3.5** — `networkMode:'offlineFirst'` parks a fetch-`TypeError`-while-offline and retries on reconnect; new **`isPaused`** signal on `AsyncState` (added to every producer — Entry/InfiniteEntry/both subs/LocalCache/fakeAsyncState). SPEC §5.3/§5.5; API.md.
- **T3.6** — optimistic `snapshot.rollback()` re-emits a `SetDataEvent` (guarded on an actual data change) so cross-tab and entity peers drop failed optimistic state. `entities/query-client.md`.
- **T3.7** — infinite refetch re-fetches **all** loaded pages (`runRefetchAll`), not collapse-to-page-one; atomic update, no truncation flash. SPEC §5.7. Infinite SSR dehydrate deferred → BACKLOG + SPEC §15 + react README.
- **T3.8** — `stableHash` reads the raw holder property (`this[key]`) so Date tagging + the class-instance throw aren't dead code (`toJSON` runs before the replacer).
- **T3.9** (commits a–e2):
  - An `onMutate` throw aborts the run.
  - `subscription.refetch()` resolves on supersede instead of rejecting with an AbortError.
  - Exponential retry-backoff is the default.
  - `dispose()` resets `isFetching`.
  - Focus and `visibilitychange` are debounced, and a tick joins an in-flight fetch.
  - `invalidate` marks stale only when the entry is subscriber-less, via `markStale`, `forcedStale` and `client.invalidateEntry`.
  - Query and mutation registries are shared on `globalThis`, against the dual-package hazard.
  - A duplicate `queryId` dev-warns.
  - `_unregisterMutationById` moved to `/testing`.
  - Streaming `flush()` skips un-serializable entries.

New public surface: `Query.cancel` and `cancelAll`, `subscription.cancel`, `AsyncState.isPaused`. New `Entry`/`InfiniteEntry` methods: `cancel`, `markStale`. Regression tests R-Q3.1…R-Q3.9 in `regressions.test.ts` (+ `stableHash` cases in `query.test.ts`; offlineFirst and focus-double-fire in `query-focus-online.test.ts`; streaming guard in react `streaming.test.tsx`).

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
- **T4.7** (2 commits):
  - Dropped `aria-errormessage`, because ARIA wants an ID reference rather than text.
  - `useFieldInput` keeps the transform in a ref, so handlers memo on `[field]`.
  - Fixed the reset and suspense docstrings.
  - The streaming docstring passes the plugin through `HydrationBoundary` options.
  - Teardown re-installs a **queue** rather than an inert sink, so late stream entries are not dropped.
  - `context.ts` uses `RootOptions` in place of `options as any`.
  - `[?]` The disabled-plus-suspense guard was reverted. An idle-no-data subscription is indistinguishable from one torn down at dispose, which produced teardown false-positives and a React-19 `uncaughtError`. The limitation is in BACKLOG.

New public surface: `Mutation.status`. Tests in `packages/react/tests/*` (hydration-boundary, adapter, suspense, keep-alive, streaming).

### Gates

`pnpm build` + `pnpm typecheck` clean (all packages + examples); `pnpm exec biome lint .` clean (274 files); `pnpm test` → 689/689 across 56 files.

## [2026-07-25 16:47] ingest | REMEDIATION.md phase 5 (forms)

Phase 5 — `packages/core/src/forms/` (field, form, validators). Three commits.

- **T5.1** — `FieldArray` tracks **structural dirtiness** (`structurallyDirty$`, flipped by `add`/`insert`/`remove`/`move`/`clear`, reset by `reset()` and `replaceInitialItems`). `isDirty = structural || anyItemDirty`. Before this, a reactive `initial: () => queryData` + default `resetOnInitialChange: 'when-clean'` re-seated the array on a background refetch and silently **deleted rows the user just added**. Pinned `R-F5.1`. SPEC §8.5; `modules/forms.md`.
- **T5.2** — form-/array-level validators can **target specific fields**. `Validator<T>` widened to also return `FormIssue[]` (`{ path, message }`); `runTopLevelValidators` collects issues (`appendIssues`) and `routeFormIssues(this, …)` routes empty-path → the node's `topLevelErrors`, path → `resolveNode`'s descendant via `setFormErrors`. Fields gain a **third error channel** `formErrors$` (merged into `errors`); Form/FieldArray merge parent-injected errors into `topLevelErrors` (now a computed) + `isValid`. Cleared/re-applied each run (`lastFormErrorTargets`). Standard-Schema `validator()` rewritten to return **all** issues as `FormIssue[]` with paths; `zodValidator` inherits it. `debouncedValidator` narrowed to a precise `string | null` return so direct callers still type-check. Pinned `R-F5.2` + `standard-schema.test.ts`. SPEC §8.1/§8.3/§20.7; API.md; `modules/forms.md` + `zod.md`. BACKLOG: formFromZod root `.refine({path})` routing.
- **T5.3** — minor batch:
  - `validateOn: 'blur'` and `'submit'` are now tested; they had zero coverage.
  - `dirtyFields` and `clearSubtree` are tested.
  - `required(false)` now **passes**, because a boolean is a legitimate value. A new **`mustBeTrue`** validator covers consent checkboxes.
  - `isValid` **holds its last-known validity while `isValidating`**, through `lastValid$`, so a `debouncedValidator` no longer strobes a submit button. This replaces the old invalid-while-validating rule; SPEC §8.2 and the docstring were updated.
  - `Form.reset()` re-applies initial **inside** the batch, so nothing tears.
  - A thrown validator's message is **generic in production**, reading `'Validation failed'`, while `onValidatorError` still routes the real error. Dev builds keep the message. New tests in `form.test.ts` + `validators.test.ts`; `controller.test.ts` isValid-while-pending assertion updated.

New public surface: `FormIssue` and `ValidatorResult` types, `mustBeTrue` validator. `Validator<T>` return widened.

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
  ancestors-only `ReadonlySet` per level (a DAG `{a:obj,b:obj}` and collapse→expand
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
  `finally` + swallows the losing race promise (no unhandled rejection and leaked
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
all executed by `fork` subagents + independently gate-verified. **No publish,
version bump, tag or push** — the actual `npm publish` is deferred to the
maintainer (outward-facing, needs authorization); T7.1's Publish sub-item stays
`[ ]` on purpose.

- **T7.1 release prep** (`ba0b9cb`) — fixed the stale `# @olas/*` CHANGELOG
  headers → `@kontsedal/*`; back-filled a consolidated 0.0.7–0.0.15 block per
  package (flagged as bumped-but-never-published — npm froze at 0.0.6);
  a `patch` changeset for the remediation across all 10 published packages; a
  `main`-only, `NPM_TOKEN`-gated `.github/workflows/release.yml` (changesets/
  action — can't fire by accident without the secret). No `changeset version`.
- **T7.2 verify what you ship** (`2800e1a`) — `publint` + `@arethetypeswrong/cli`
  per package in CI (both already clean — only finding was the missing
  `engines`, now added: `node >=18` on all 10 published packages); a zero-dep
  dist smoke test (`scripts/verify-dist.mjs`, `pnpm smoke:dist`: ESM import + CJS
  require each built entry + a `__DEV__`-leak grep — none leaks, tsdown defines
  it correctly); coverage thresholds in `vitest.config.ts` seeded below
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

**Core (T8.1).** `DebugEvent` now carries optional `seq`, `t` and `causeId`
(distributive `Body & Meta`, so `switch` still narrows); `DevtoolsEmitter.emit`
+ replay stamp `seq`/`t` centrally. New events: `cache:set-data`
(`source` + post-write `data`) and `snapshot:push`/`rollback`/`finalize`. A
dev-only ambient cause (`__runWithCause` and `__currentCauseId`) threads a
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
synchronously) worked, but every coalesced signal (cache, mutations, fields and
timeline) stayed permanently empty with no console error. jsdom's rAF ignores
`this`, so the whole RTL suite passed. Fixed by wrapping rAF/cancelRAF in arrows
(`store.ts`); added a regression test that installs a strict `this`-checking rAF
under vitest; documented in `pitfalls/raf-unbound-illegal-invocation.md`.

### Gates

`pnpm test` → 788/788 across 58 files; `pnpm build` + `pnpm typecheck` clean
(all packages + examples); `biome` clean.

---

## [2026-07-28 22:57] ingest | ctx.debug — controller "Variables" view

New opt-in devtools primitive: `ctx.debug({ count, doubled, … })` exposes named
live values for the panel's Tree, rendered reactively (no polling).

**Core.** `Ctx.debug(values)` (`instance.ts` buildCtx) merges the record onto
`ControllerInstance.debugValues`; dev-only (`if (!__DEV__) return`), no
LifecycleEntry, no `assertLive`. During construction the record rides out on
`controller:constructed` (new optional `debug` field); a post-construction call
emits the new `controller:debug` event. `DevtoolsEmitter` tracks/replays `debug`
per live controller. SPEC §3.2/§14/§20.2 updated.

**Devtools.** `ControllerNode.debug`; `insertNode` carries it, `setNodeDebug`
updates it; `controller:debug` kept off the timeline. `<TreeNode>` renders a
Variables section (open by default); `<DebugVar>`/`<ReactiveValue>` duck-type
signal-likes (`peek`+`subscribeChanges`) and `use()` them so values update live;
non-signals show a static snapshot. Dogfooded in the kanban board controller.

New wiki pitfall/entities updates + `pitfalls`/`ctx.md`/`devtools.md`/
`devtools-panel.md`. Reactive display verified by an RTL test that flips a signal
and asserts the panel re-renders.

### Gates

`pnpm test` → 797/797 across 58 files; `pnpm build` + `pnpm typecheck` clean
(all packages + examples); `biome` clean.

## [2026-07-29 12:50] ingest | RootOptions.defaultQueryOptions — root-wide query defaults

App-wide query policy is now declarable once at `createRoot` instead of restated
on every `defineQuery`. New `DefaultQueryOptions` type (a `Pick` off `QuerySpec`
so it can't drift) covers `staleTime`, `gcTime`, `retry`, `retryDelay`,
`keepPreviousData`, `networkMode`, `structuralShare`, `refetchOnWindowFocus`,
`refetchOnReconnect`. Resolution is uniformly `spec.X ?? client.defaults.X ??
built-in` — a per-query field always wins. SPEC §5.9 gained a "Root-wide query
defaults" subsection.

Motivation: the quiet built-ins (`staleTime: 0`, `retry: 0`) are right per query,
but an app wanting different ones repeated them N times, and a missed one
presents as "why is this refetching on every subscribe?" rather than an error.
Surfaced while planning a real TanStack→Olas migration of a ~96k-LOC renderer,
where the porting checklist's highest-risk item was exactly this restatement.

Threaded at five sites: `ClientEntry` + `InfiniteClientEntry` ctors (entry
options + `gcTime`), `createUse` + `createInfiniteUse` (`keepPreviousData` lives
on the subscription, not the entry), and `instance.ts` `cache()` for `ctx.cache`.
`createTestController` accepts the option too.

Deliberate non-uniformities, all recorded in `entities/query-client.md`:
`refetchInterval` is NOT defaultable (a root-wide interval would silently poll
every query); `refetchOnWindowFocus`/`refetchOnReconnect` are no-ops for infinite
queries (no focus/online subscription exists there); `ctx.cache` gets only
`staleTime`/`keepPreviousData` (the only fields `LocalCacheOptions` carries).
Flat `RootOptions.refetchOn*` kept as shorthand; `defaultQueryOptions` wins.

Test-design lesson worth keeping: two `createTestController` calls build two
roots and therefore two caches, so a "re-subscribe hits the cache" assertion
passes vacuously. gcTime/dedup behavior must be exercised inside ONE root via
`ctx.session`. Two of the new tests initially passed for that wrong reason and
were rewritten (staleTime now proven via the staleness timer + a focus-refetch
gate; gcTime via session open/close plus a long-gcTime control).

### Gates

`pnpm test` → 813/813 across 59 files (16 new in
`packages/core/tests/query-default-options.test.ts`); `pnpm typecheck` +
`pnpm build` clean across all packages and examples; `biome check` clean.

## [2026-07-31 09:05] ingest | Mutation.reset() TSDoc claimed the opposite of its behavior

Docs-only correction. `Mutation.reset()`'s one-line TSDoc read "Clear `data`,
`error`, `lastVariables` and `status` **without aborting in-flight runs**". The
implementation has aborted in-flight runs since the file's first commit
(`mutation.ts:505-525`), SPEC §6.2 lists `reset()` among the abort triggers, and
two tests pin it (`mutation.test.ts:54`; regression B2 for the queued-`serial`
rejection). The false sentence entered in 612720b — a docs-only sweep — and had
never been true. This wiki page (`entities/mutation.md:87`) has described the real
behavior the whole time; the lie lived only in the shipped `.d.ts`, which is
exactly where consumers read it (editor hover).

Worth keeping: the reason it survived ten weeks and three releases is that it is
*plausible*. react-query's `reset()` does detach the observer and let the
in-flight request finish, so anyone porting from rq reads the wrong line and
finds it confirming what they already believed. The change request that prompted
this reported a consumer shipping a backwards code comment off the line; that is
second-hand and nothing in this repo corroborates it, so treat it as motivation
rather than as a recorded fact. Either way the correction carries an explicit
"do not map an rq `reset()` onto this" warning in three places — the TSDoc,
`API.md`'s Mutations section, and `MIGRATING.md`'s "patterns that don't
translate one-to-one" list — rather than only deleting the wrong clause.

Generalizable lesson for docs-only sweeps: a sweep that rewrites doc comments
without re-reading the bodies below them can invert a contract, and nothing in
CI catches it. Typecheck, tests, lint and `verify:dist` are all blind to prose.

### Gates

No code changed. `pnpm test` → 813/813 across 59 files (unchanged);
`pnpm typecheck` + `pnpm lint` clean.

## [2026-07-31 09:20] ingest | refetchInterval accepts (data) => number, resolved per tick

`QuerySpec.refetchInterval` and `InfiniteQuerySpec.refetchInterval` are now
`RefetchInterval<T> = number | ((data: T | undefined) => number)` (new exported
type in `query/types.ts`, next to `RetryPolicy` and `RetryDelay`). SPEC §5.9 gained
a "`refetchInterval` — fixed or data-driven" subsection carrying the contract.

Motivation is one shape: poll fast while there's work, slowly when idle. With
only a number you pick between a wasteful cadence at rest and a sluggish one
under load, or you run a second timer alongside the query and race it.

Implementation: both interval timers (`ClientEntry`, `InfiniteClientEntry`)
went from `setInterval` to a self-rescheduling `setTimeout` chain, because a
fixed-period timer can't re-ask for its period. Two subtleties, both now pinned
by tests:

- **The re-arm happens first**, before the hidden-tab and in-flight guards and
  before `startFetch()`. Ordering it after the guards was the tempting reading
  and it breaks two things at once: the cadence would stretch to
  settle-plus-gap on any slow fetch, and — worse — the first skipped tick would
  end polling for the life of the entry. Verified by inverting the order
  locally: three tests go red.
- **`ClientEntry<T>` must not hold the raw `RefetchInterval<T>`.** A
  `(data: T | undefined) => number` member puts `T` in a contravariant position,
  which makes the class invariant and breaks every `ClientEntry<unknown>`
  boundary in `client.ts` (the maps, `dropEntry`) — four typecheck errors far
  from the edit. Fixed by storing a `() => number | null` closure instead, which
  keeps `T` internal. Same treatment on the infinite entry for symmetry.

Defensive contract: a resolved gap that isn't a positive finite number stops the
chain and `__DEV__`-warns rather than scheduling `setTimeout(…, 0)` — a
fetch-per-macrotask loop presents as a hung tab, not as a config error. The tick
that discovers the bad value still runs its own fetch (the re-arm precedes it);
only subsequent ticks are cancelled.

Because the rule is written against the *resolved gap* rather than against the
thunk, it also binds a numeric literal — and that is a real behavior change on
the number form, disclosed in the changeset: `refetchInterval: 0` used to mean
"fetch every macrotask" (`setInterval` clamps 0 to about one tick) and now warns
once and never arms. Pinned by its own test so nobody restores the hot loop by
"fixing" the guard.

A **throwing** thunk routes to that same path, with a warning that distinguishes
it. This one was nearly shipped as a known gap: the first draft guarded the
return value but not the call, and it went into `BACKLOG.md` as future work.
That was the wrong call and it's worth remembering why — the resolution runs
*before* the re-arm inside the timer callback, so an unguarded throw skips the
re-arm and ends polling for that entry permanently, surfacing only as an
uncaught error in a timer with no `dispatchError` route and no entry-level
record. That is the identical failure class the re-arm-first ordering exists to
prevent (an unguarded call in a self-rescheduling chain = a permanently dead
subsystem, silently). Guarding it is four lines; deferring it would have shipped
a silent-death path in a brand-new API. Generalizable: in a self-rescheduling
chain, every expression evaluated before the re-arm is load-bearing and must be
total. Applied to the letter on review — the data read had been sitting in argument
position (`resolveRefetchInterval(interval, this.entry.data.peek())`), i.e.
outside the try it was supposed to be protected by. `entry.data` is a `computed`
on infinite entries and a computed can throw, so the read now goes in as a thunk
and is evaluated inside the guard. Unreachable today; the point is that "total
before the re-arm" is a property of the whole expression, not just the
user-supplied part.

Two wording corrections from the same review, both about precision rather than
behavior. "The next subscriber re-arms it" was wrong in five places (both
warning strings, the JSDoc, §5.9, the changeset): re-arm happens on the entry's
0→1 transition, so a subscriber joining an entry that still has others changes
nothing. The warning strings are the user's recovery instruction, so they now
say it explicitly. And the JSDoc/spec now record that the first resolution is
synchronous at acquire with `data === undefined`, and that a misconfigured entry
re-warns once per 0→1 cycle (a StrictMode double-mount prints two).

Deliberately unchanged: `DefaultQueryOptions` still excludes `refetchInterval`,
`UseOptions` still has no interval (the timer is per **entry**, so per-subscriber
intervals would need a "whose interval wins" rule), and `ctx.cache` with
`LocalCache` gains nothing here. All three are now stated in §5.9 rather than
inferable.

Coverage gap closed while here: the hidden-tab skip had **zero** tests since it
shipped. Two now exist (number + function form) in `query-focus-online.test.ts`,
the only jsdom query test file. Also swept SPEC §20.4's two spec listings, which
had drifted well past `refetchInterval` (missing entirely on `InfiniteQuerySpec`
despite the field being implemented and tested): `QuerySpec.fetcher` still
showed the pre-`FetchCtx` `(...args, signal)` signature, both listings were
missing `networkMode` and `structuralShare`, `InfiniteQuerySpec` was missing
`keepPreviousData`, and both showed `crossTab?: boolean` rather than
`boolean | 'data'`. `FetchCtx` or `InfiniteFetchCtx` are now written out there
instead of being inlined wrong.

Type-level note for the changelog: `QuerySpec<Args, T>` is now **invariant** in
`T`, because the thunk puts `T` in a function-parameter position. `defineQuery`
infers `T` from the fetcher so the normal path is unaffected; only code that
annotates `QuerySpec` explicitly and relies on assignability between two
instantiations sees it.

### Gates

`pnpm test` → 823/823 across 59 files (10 new: 6 in `query.test.ts`, 2 in
`query-focus-online.test.ts`, 1 in `infinite.test.ts`, 1 regression pin under
R-Q3.2); `pnpm build` + `pnpm typecheck` + `biome check` clean;
`pnpm verify:dist` green on all ten packages; `pnpm --filter "./examples/*"
test` green.

## [2026-07-31 10:40] ingest | the lockstep group was about to release 1.0.0, not 0.4.0

Caught by review before push. With two changesets pending (one patch, one minor
on `@kontsedal/olas-core`), `changeset status` reported **all ten packages at
major**. Root cause is in `@changesets/assemble-release-plan`'s `shouldBumpMajor`
(dist ~330-346): the peer-dependent major check is

```
depType === 'peerDependencies' && nextRelease.type !== 'none' && type !== 'patch'
  && (!onlyUpdatePeerDependentsWhenOutOfRange || !semverSatisfies(next, versionRange))
```

and `onlyUpdatePeerDependentsWhenOutOfRange` defaults to **false**, so
`!false` short-circuits the whole range test. Any non-patch core bump majors all
nine peer-dependents regardless of what their ranges say, and the `fixed` group
then propagates that major back onto core. Nothing about the ranges could have
prevented it.

That matters because 0.3.0 had already "fixed" this — by widening the nine
`peerDependencies` from `workspace:^` to `>=0.3.0`, reasoning that a caret below
1.0 pins the minor so a core minor left the range. Correct diagnosis of one half
of an `||`, wrong half: the range was never consulted. The fix went unverified
because 0.3.0 shipped no minor after it, so the first real test of it is now.
`BACKLOG.md`'s entry has been rewritten to say so and to keep only the residue
(the missing `<1.0.0` ceiling, cosmetic under lockstep).

Fix is one config key —
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange: true`
in `.changeset/config.json` — which makes the ranges load-bearing. Verified both
ways: `changeset status` now reports minor for all ten, and a throwaway
`changeset version` produced 0.4.0 across the board with every peer range left
at `>=0.3.0` (0.4.0 satisfies it, so nothing needed rewriting).

Two things to carry forward. The option name advertises that it can change in a
patch, so pin attention on it when bumping `@changesets/cli`. And the general
shape: a release config can be wrong for a whole release cycle without any test
noticing, because nothing in `install → typecheck → lint → test → build` reads
it — the only detector is running `changeset status` before a release, which is
worth doing on any PR that adds a non-patch changeset.

## [2026-08-08 22:44] schema-change | invalidate / invalidateAll now return Promise<void>

`Query.invalidate` and `invalidateAll`, the `InfiniteQuery` equivalents, and
`LocalCache.invalidate` changed return type `void` → `Promise<void>`, resolving when the
refetch(es) they trigger have **settled** (immediately for a subscriber-less entry;
`Promise.all` across a query's `__clients` and across all entries for `invalidateAll`).
They never reject — a fetch error routes to the root's `onError` and stays on the entry's
`error` signal — so `await query.invalidate(id)` is a safe sequencing point without a
`try/catch`, matching TanStack's `invalidateQueries`. Non-breaking: existing fire-and-forget
callers ignoring the return still work. The plumbing already existed — `Entry.invalidate()`
returns `Promise<T>`; `client.invalidateEntry` now returns that (mapped to `void`, errors
swallowed for the awaiter) instead of discarding it, and `define.ts` and `local.ts` propagate
it. Touched: `query/client.ts` (invalidateEntry + the 4 methods), `query/define.ts` (both
handles), `query/local.ts` (LocalCache), `query/types.ts` + `query/infinite.ts` (types),
`SPEC.md` §5.7 + the three type blocks. Updated `modules/query.md`,
`decisions/per-root-query-client.md`, `entities/query-client.md`. Motivation: the Monghoul
integration hit this repeatedly — a helper had to join a `prefetch` onto each `invalidate`
purely to get something awaitable (invalidation as a sequencing primitive).

## [2026-08-12 17:45] ingest | Query.peek + Query.write — the read side of the imperative surface, and canonical vs optimistic writes

Two additive `Query` methods, both from the Monghoul integration (the same source as
0.5.0's three ergonomics fixes), plus the doc correction that motivated the second one.

**`peek(...keyArgs): T | undefined`** — `client.peekData`. The imperative surface could
already *write* a keyed entry from outside a subscription (`setData`, `cancel`) but not
*read* one; downstream that asymmetry cost four workarounds — an optimistic `setData`
downgraded to a plain `invalidate` because there was no way to read the previous value, a
construction-time cache read replaced by a derived one-shot latch, a targeted
"find-by-field" scan degraded to a coarse `invalidateAll()`, and one real server
round-trip through the vanilla client to answer a question the cache already knew.
Deliberately does NOT call `bindEntry` (a peek must not mint the entry it reports on, or
"is anything cached?" answers itself yes) and reads via `.peek()` (no reactive
dependency — a `peek` inside a `computed` must not silently behave like a subscription).
At the handle level: first `__clients` member holding data, no throw on zero clients
(unlike `prefetch` — "nothing cached" is a correct answer), no multi-root warning (a read
is side-effect-free and the warning would fire from the hot paths peek exists for).

**`write(...keyArgs, updater): void`** — `client.writeData`, i.e.
`Entry.setData(updater, { track: false })`. The **userland canonical write**. SPEC §6.4
already recognised the category ("canonical cache writes … write straight through the
entry without pushing a snapshot") but only plugins could perform one — `setEntryData`
is plugin-facing and `queryId`-routed. So a fire-and-forget patcher in application code
(server-push fold, realtime event) had to use `setData` and then either discard the
`Snapshot` — leaving a LIVE record: `hasPendingMutations` wedged at `true` plus one
retained baseline per call, unbounded on a long-lived entry patched per event — or
remember `finalize()` at every site. Downstream accumulated eight such sites and filed it
as "mint a `writeTab` helper with `{ track: false }`", i.e. re-derived this method as glue
it could not implement, `track` being internal. Not an options bag on `setData`: the
signature is variadic (`[...Args, updater]`, recovered positionally at
`define.ts:104`), so a trailing options object is not cleanly distinguishable from a key
argument. Rationale preserved in `decisions/canonical-vs-optimistic-writes.md`.

**The doc fix that came with it.** A downstream regression (an optimistic toggle reverting
after hide→show) traced to a false-but-plausible optimisation: *"nothing calls
`invalidate()` on this query, so no fetch can be in flight — skip the `cancel()`"*. Unsound —
an entry refetches whenever a subscription acquires it **while stale**: first subscriber,
second root on the same key, or `resume()` after a suspend, all `staleTime`-driven with no
invalidator in the program. Transient, self-healing, review-surviving; caught only by
mutation-testing the `cancel()` back in. Now stated in SPEC §5.5 + §6.4 and in the TSDoc
on `setData` and `cancel`, and filed as `pitfalls/no-invalidator-still-refetches.md`.

**Also corrected while adjacent** (pre-existing drift, all doc-only): `API.md`'s
`Query<Args, T>` block still typed `invalidate` and `invalidateAll` as `void` (0.5.0 made
them `Promise<void>`) and omitted `cancel` and `cancelAll` though the prose listed them; its
`ctx.use` options bag omitted `keepDataWhileDisabled` (0.5.0); SPEC's §21 appendix `Query`
block omitted `cancel` and `cancelAll`; `CLAUDE.md`'s implementation-status line said 621
tests across 55 files (now 843 and 59).

**New**: `RECIPES.md` gains the **`readsFactory`** recipe — the supported answer for a
React context/hook that needs server data and owns no controller (a controller owns the
subscriptions and exposes them; React reads by identity via `useRoot()` + `useQuery(sub)`).
Downstream invented this shape twice independently (`themeReads`, `uiReads`) after hitting
the same wall, so the pattern was load-bearing and undocumented. The API it implies —
`useQuery(query, { key })`, a component minting its own subscription — is filed
`[dropped]` in BACKLOG.md with the reasoning (it would move data lifetime back into the
view, and would be reached for far past the provider case).

BACKLOG also gains `peek`/`write` for infinite queries (the same leak is still reachable
there; `InfiniteEntry.setData` already takes `{ track: false }`, so it is mostly plumbing +
one open question about whether an infinite `peek` returns pages or flattened items) and
`subscription.refetch()` rejecting when detached (four `.catch(() => {})` sites downstream
exist only to silence it; every fix is either a breaking return-type change or new
surface, so recorded rather than done).

Tests: 12 new cases in `packages/core/tests/query.test.ts` (two describes). Each of the
four load-bearing behaviours was mutation-verified red: tracked `write` (→ the two
no-snapshot cases fail), entry-creating `peek` (→ the non-creation case fails),
`.value`-instead-of-`.peek()` (→ the no-dependency case fails), and a `write` that skips
`emitSetData` (→ the plugin-event case fails). Gate: typecheck clean, `biome lint .`
clean, 843 tests and 59 files, build clean. `pnpm lint` still reports formatter errors on 5
root config files — the known Windows CRLF issue already in BACKLOG.md, untouched by this
change (staged diff contains zero CR).

## [2026-09-03 22:40] ingest | mutation dispose semantics + detached runs (§6.5)

Three defects found by auditing a consumer's backlog of "olas bugs" against the source, plus one doc divergence. All shipped in one change; `pitfalls/dispose-order-is-registration-order.md` is new and `entities/mutation.md` is updated.

- `run()` after dispose rejected with a bare `Error('Mutation disposed')` — not matched by the library's own `isAbortError`, while `dispose()`'s serial-queue rejection three lines below was an `AbortError`. Now `MutationDisposedError`, exported and deliberately not an abort.
- A run whose `mutate` had already resolved was rolled back and settled `'cancelled'` when the abort landed in the gap before its continuation. That committed a knowingly stale value to a surviving cache, and told the mutation queue to replay a write the server had accepted. It now finalizes and settles `'success'`.
- `detached: true` added: dispose stops cancelling, so a write outlives the screen that started it. `reset()` and `latest-wins` still cancel.
- `SPEC.md` §4 claimed teardown ran "children → caches/effects → onDispose hooks". It is one reverse-registration pass over all kinds. The wiki said "iterates reverse" correctly in three places the whole time — spec and wiki disagreed for months with nothing checking one against the other.


## 2026-09-19 — 0.9 cache identity and root isolation

Added bound query actions for regular and infinite queries, with ambiguity guards. Scoped mutation-queue replay invalidation. Required explicit IDs for SSR serialization. Replaced sentinel key encoding with full type tagging. Fixed infinite and long stale timers. Updated query, SSR, Entry, root-isolation decision and replay docs. Regression tests cover separately evaluated server/client modules, request-local cache actions and timer boundaries. Coverage now includes implementation entry points and TSX files with unchanged thresholds.

## 2026-09-20 — follow-ups from the 0.9 review

Reviewing the 0.9 branch against the five reported defects: all five were fixed, but the
stale-timer fix stopped one class short.

- **`gcTime` had the same defect `staleTime` did.** `scheduleStaleTimeout` fixed staleness while the
  gc timer kept calling `setTimeout(fn, this.gcTime)` raw in four places, so `gcTime: Infinity` — the
  natural spelling of "cache for the session" — dropped the entry ~1ms after its last subscriber
  left, and so did any `gcTime` past 2,147,483,647 ms. Verified before the fix with a single root and
  a signal-driven key: `Infinity` and `2^31-1 + 5000` both refetched on return, a `60_000` control did
  not. The scheduler is now `scheduleExpiry` in `expiry-timer.ts` (renamed from
  `stale-timer.ts`, since it is no longer stale-specific) and backs both timers.
- The lesson is in `pitfalls/isstale-needs-timer.md` rather than only in the fix: that page already
  taught "you need a timer, not a computed" and its code sample was itself the `setTimeout(fn, delay)`
  shape that fails. It now carries the second half — any timer whose delay comes from user config
  needs `scheduleExpiry`, because the failure is silent and inverts the setting.
- **`dehydrate()` skipping anonymous queries was silent.** Safe (the client refetches) but invisible;
  the only symptom of a forgotten `queryId` was a slower page. It now counts the successful entries it
  had to drop and warns once per call in dev.
- Smaller: the mutation-queue's `onReplaySettle` invalidate warns instead of no-opping when the plugin
  is not attached; a `realtime` docstring still showed an unbound `ordersQuery.invalidateAll()`.
- The `peek` break is documented rather than softened. 0.8 deliberately never warned from `peek`
  because it runs in click handlers; 0.9 throws there under multiple roots. That is the right call —
  reading an arbitrary root is how the wrong user's data reaches the screen — but it surfaces at
  runtime, not at the type level, so MIGRATING and the changeset now call it out as the edge to audit
  first.

## 2026-09-20 — second review pass: the rest of the timer class, and a docs sweep

An independent review of the 0.9 branch rated it 8/10 and found the previous pass had stopped one
step short in two directions.

- **The expiry-timer fix was incomplete.** Staleness and gc were routed through the shared scheduler;
  `refetchInterval`, the retry backoff and `suspend({ maxIdle })` were not. `refetchInterval` looked
  guarded and wasn't: `resolveRefetchInterval` rejects non-finite and non-positive gaps, which covers
  `Infinity`, but a *finite* gap above 2^31-1 passes that guard and still overflows — a ~1ms poll
  storm out of the longest interval you can ask for. Rejecting `Infinity` is not the same as handling
  overflow. All three now go through `scheduleExpiry`, which moved to `src/expiry-timer.ts` (it has
  consumers in `query/`, `controller/` and `utils.ts`, so it no longer belongs under `query/`).
  Four tests, each verified to fail against the raw-`setTimeout` version.
- The worse half: the previous pass wrote the false claim into
  `pitfalls/isstale-needs-timer.md` ("`refetchInterval` doesn't need it"). A wiki page asserting
  something wrong is worse than silence, because every later query inherits it. Corrected, and the
  page now names every user-supplied duration in core rather than listing two.
- **`-0` was splitting cache entries.** The tagged key encoding distinguished `-0` from `0` and a test
  pinned it deliberately. But `-0` arrives from arithmetic (`x * -1`), never on purpose; every
  equality a caller touches treats the two as one; and `JSON.stringify(-0)` is `'0'`, so a `-0`-keyed
  entry could dehydrate on the server and never be adopted on the client. Normalized, test flipped.
- **A docs-wide sweep for unbound query calls.** `RECIPES.md` had never been migrated (a router-loader
  `prefetch` that rejects under per-request SSR roots, and a realtime handler doing fire-and-forget
  `setData`); `packages/router/README.md` had the same loader; SPEC, API.md, the cross-tab README and
  a pitfall page had their own. The kanban example was patching the cache with fire-and-forget
  `setData` in five places — leaking a snapshot per call, against the library's own documented reason
  for `write` existing. Fixed everywhere; the archive one uses `.finalize()` because infinite queries
  have no `write` yet (BACKLOG).
- `ReplaySettleApi.invalidate`'s parameter was named `keyArgs` but takes *call* args — free to rename
  now, expensive after 0.9 ships. Renamed, README row corrected.
- Removed four `examples/*/CHANGELOG.md`: the examples are `private: true` and changesets is
  configured not to version them, so these were stale artifacts recording versions that never shipped
  (`@kontsedal/olas-react@1.0.0`).

## 2026-09-20 — independent versioning, and publishing behind a manual trigger

Two release-process changes, both reversing earlier decisions recorded in this log.

- **Dropped the `fixed` lockstep group.** All ten packages shared one version and bumped together, so
  a core-only change dragged nine untouched packages to a new version and the changelog claimed
  releases that contained nothing. Removed; packages now version independently. Verified with
  throwaway changesets against this tree: a core minor + a zod patch produces core 0.9.0, zod 0.8.1
  and leaves the other eight alone, and the real changeset on this branch bumps only core and
  mutation-queue — the two that changed.
- Lockstep was also what made the missing peer-range ceilings harmless ("cosmetic while all ten ship
  in lockstep", 2026-07-31). Dropping it makes them load-bearing, so every internal peer range gained
  `<1.0.0`. Verified both directions: an in-range bump leaves ceilings intact and cascades nothing; an
  out-of-range bump (core → 1.0.0) majors all nine and rewrites their ranges. The rewrite still drops
  the ceiling — changesets manages the floor and discards the rest — but that now surfaces in a PR
  diff a human reads. BACKLOG updated from "open" to "resolved for 0.x, with this caveat".
- **Publishing is no longer a side effect of merging.** `release.yml` did both jobs: it opened the
  version PR, and when that PR merged it published to npm. Split into `version.yml` (push to `main`,
  opens the PR, has no `publish:` input so it *cannot* release) and `publish.yml`
  (`workflow_dispatch`, main-only, typed confirmation, re-runs the full verify chain first). Merging a
  PR is a low-ceremony act several people can do; an npm version can never be reused. Those should
  not be the same gesture.

## 2026-09-20 — the writing rules, written down

Applied the fonbnk codebase wiki's prose rules across all 79 Markdown files, then wrote the rules
themselves into `decisions/prose-rules.md` so the next session inherits the calibration rather than
re-deriving it.

- Ported that repo's `wiki-lint.js --style` to `scripts/prose-lint.mjs`, same thresholds, wired as
  `pnpm prose:lint`. It is opt-in: no hook, no CI step.
- The pass took 1989 findings to 1042. `slash-or` and `banned` went to zero. `hedge` went 92 to 8,
  and each survivor is temporal or inside a quotation.
- The decision page carries the part that is not in fonbnk's docs: the four shapes we leave flagged
  on purpose. Em dashes are half the findings here and mostly earn their place. An absolute that a
  test pins stays absolute. A code citation in parentheses is exempt by the written rule but still
  counted. Terse changelog annotations in this file read better than the sentences they would become.
- Fixed a real bug in the port while checking the new page against its own rules. The quote-collapse
  pass runs before the line split, and a long quoted span can swallow the newline and leading `|`
  between two table rows, hiding the second row from the table check and scanning it as prose. The
  page's own rules table tripped it: 8 of its 11 findings were the table being read as prose.
  Structure is now read from the original lines, so the collapse cannot move it.


## [2026-09-20 14:30] ingest | one interface spirit across five surfaces

Distilled the interface rules, wrote them down, and applied them to the four example apps and the
devtools panel. New page: [decisions/ui-rules.md](decisions/ui-rules.md).

What the pass found, counted rather than remembered: 15 distinct literal font sizes in kanban and
9 in devtools, 8 corner radii in devtools, a violet-indigo accent on four of the five surfaces,
one `prefers-reduced-motion` block against nine animations, and four elements pairing a border
with a shadow.

New file `examples/_shared/ui/tokens.css` holds the scales every example shares — type by role,
three corner tiers, the control ladder, space, motion and the palette. `packages/devtools` carries
the same scales by value, because it ships its CSS inline in a TS string and has no stylesheet a
host could import. That duplication is deliberate and is stated in both files.

Five things the measurement found that looking would not have:

- `--color-border-strong` measured 1.7-2.0:1 against the surfaces it edged, against the 3:1 WCAG
  1.4.11 asks of a control's boundary. Split into `--color-border-control`, solved, with
  `--color-border` staying a quiet divider.
- Solving the foreground tiers straight to the floor put two of the three 0.04 apart in lightness.
- Four accent and status values were authored outside sRGB and would have been clipped.
- A fixed lightness and chroma across arbitrary hues failed at hue 192 and fell out of gamut over
  a third of the circle. That is why a data hue now picks a slot in an eight-colour identity
  palette at the render boundary rather than reaching the CSS raw.
- `examples/stock-ticker/src/dom.ts` stroked its sparkline with `var(--green)` and `var(--red)`,
  declared nowhere in the repo.

Also closed: `JsonView` had zero `aria-` attributes while being an expand and collapse tree, and
kanban handed the devtools panel three custom properties the panel does not read.

The page states plainly that nothing gates any of the ten rules.

---

## [2026-09-20 15:10] ingest | `@kontsedal/olas-dom` — the vanilla adapter ships

The adapter SPEC §16 has named since the beginning now exists. It binds signals to nodes the
consumer already holds, and it does not build them.

**Two layers, one package.** The binder (`mount`, `View`) depends on core and nothing else. The
template layer is lit-html plus a 109-line bridge on the `/html` sub-path, with `lit-html` as an
optional peer, so a consumer of the package root ships no lit bytes.

**The design went through an adversarial review before any code.** The review returned a verdict
of rework and changed four things that would otherwise have shipped wrong.

- The proposed core prerequisite was broken. Adding `Symbol.for('olas.signal')` to `SignalImpl`
  and `ComputedImpl` would have missed `FieldImpl`, which is its own class, and `readOnly()`,
  which returns a frozen object literal. Both would have been misclassified as plain values. The
  duck-check on `peek` + `subscribe` + `subscribeChanges` needs no core change and is stronger.
- The in-house template engine was budgeted at 350 lines against an honest 550-750, with
  raw-text elements, attribute-name case recovery, multi-interpolation attributes and the
  different-strings-identity path all unbudgeted. Bridging to lit-html deletes the whole file.
  See `decisions/lit-html-over-own-engine.md`.
- `swap` was keyed on a value, so `() => query.data.value` would tear the subtree down on every
  refetch that minted a new object. It takes a key thunk now.
- `input()`'s four-behavior list was missing three: caret restoration around a *differing* write,
  composition guarded in both directions, and `transform` parity with `useFieldInput`.

**What the review got right that mattered most.** SPEC.md:442 rejects the `Source<T>` union by
name for `ctx.use` keys. The package keeps the union and argues the distinction in
`modules/dom.md`: a cache key is an identity where a non-thunk is a silent correctness bug, and a
binding is a sink where a plain value is correctly static.

**Enforcement.** 684 code lines, ceiling 700, checked by `pnpm dom:budget`
(`scripts/dom-budget.mjs`). A README sentence is not enforcement; the repo already runs bespoke
lint scripts and this is the same idiom.

**Parity as a test, not a claim.** `packages/integration/tests/adapter-parity.test.tsx` runs one
controller tree and one set of assertions through both the React adapter and the binder. The only
difference is that React needs `act()` to flush; the binder commits synchronously.

Drift found and fixed on the way: `modules/signals.md` documented `ReadSignal` without
`subscribeChanges`, which has been on the type since before that page's `last_verified`. The
dom package's duck-check depends on it.

New pages: `modules/dom.md`, `decisions/lit-html-over-own-engine.md`.

---

## [2026-09-20 16:40] decision | `@kontsedal/olas-dom` built, measured, and dropped

The vanilla adapter from the entry six hours earlier is deleted, uncommitted. SPEC §16 no
longer promises one. Full reasoning in `decisions/no-vanilla-adapter.md`; the short
version is three measurements taken after the package was working.

The binder was 5.9 KB gzipped. Preact is in the same range and includes a component model.
`@preact/signals` already binds a signal to a text node with no diff, so fine-grained
updates were not a differentiator either.

The decisive one generalises past preact: `@kontsedal/olas-core` is larger than any of
these renderers, so anyone shipping olas has already spent the budget a hand-rolled binder
was meant to save. "Avoid a framework to save bytes" is never live for this library's
users. That kills the size argument permanently, not just against one competitor.

The fallback case — bind DOM you did not render — did not hold either. Embeddable widgets
inject their own container and custom elements own their shadow DOM, so neither needs it.
Progressive enhancement over server HTML is real and is not this library's audience.

**What replaced it.** `@kontsedal/olas-react` imports eight hooks and three types, all
present in `preact/compat`, and never imports `react-dom`. Preact support is probably an
alias plus a test matrix. `BACKLOG.md` carries that, a framework-agnostic `bindField`
salvaged from the deleted `input.ts`, and a React-versus-preact parity test.

**Kept from the work.** The `modules/signals.md` drift fix stands on its own: the page had
documented `ReadSignal` without `subscribeChanges`, at `confidence: high`, since before
2026-05-22.

**Process.** Plan, review, build, review, measure — and the measurement came last and
reversed the decision. Measuring the bundle against preact during planning would have
stopped it. The cost of learning this was one uncommitted working tree; after
`changeset publish` it would have been a published version number that can never be
reused.

---

## [2026-09-20 19:20] ingest | core becomes tree-shakeable — ctx primitives are free functions

Two breaking changes shipped together as one pre-1.0 major. A controllers-only bundle went
from 20.1 KB gzipped to 4.8 KB. Full reasoning in
`decisions/ctx-primitives-are-free-functions.md`.

**What changed.** `ctx.field(x)` became `createField(ctx, x)`, and the same for `createForm`,
`createFieldArray`, `createCache`, `createQuery` (was `ctx.use`), `createMutation` and
`bindQuery`. `createRoot` now takes `queries: queryEngine()`. `ctx` keeps everything that
binds to the controller's tree and lifetime.

**Why the obvious fix does not work.** Constructing the `QueryClient` lazily on first use
saves nothing, because the first-use site is `ctx.use`, which lives in `instance.ts`, which
`createRoot` always reaches. The `new QueryClient(...)` expression had to leave that module
graph entirely. Same argument for the forms subsystem: an object literal's methods are not
droppable.

**Why the engine is adopted eagerly.** `QueryClient`'s constructor runs plugin `init`, and
`mutationQueuePlugin` replays mutations persisted by a *previous session* there. That is a
startup obligation, and the "any app with the plugin touches a mutation somewhere" defence
fails because that code can be route-gated. The bundle win comes from where the constructor
lives, not from when it runs.

**Measured** with `esbuild --bundle --minify --define:__DEV__=false`, gzipped, signals-core
external: signals only 0.3 KB; `+ createRoot`/`defineController` 4.8 KB (was 20.1);
`+ forms` 9.2 KB; `+ queries` 14.4 KB; everything 22.6 KB (was 21.8). Importing everything
costs 0.8 KB more than before — the indirection, paid by the people who use the features.

**Pinned by the import graph, not by bytes.** `tests/tree-shaking.test.ts` asserts that
`instance.ts` has no value import from `forms/` or `query/{local,mutation,use,client,infinite}`
and that `root.ts` contains no `new QueryClient(`. A byte-count assertion would drift with
every unrelated change; this fails the moment the coupling returns.

**SPEC was amended, not contradicted.** §3.2 recorded rejecting a `ctx` split. That rejection
was about splitting `ctx` into three *parameters* and it still stands — `ctx` is still one
parameter. What changed is that primitives which never needed to be methods stopped being
methods, which §3.3 already endorsed for every composable outside core.

Three codemod passes were needed. The first regex missed multiline calls; the paren-matching
rewrite then picked trailing commas rather than the options object; and the `ctx.` pass ran
over core's own `src`, rewriting docstrings and adding self-imports to five files. All
repaired, and worth remembering: a codemod over a repo that documents its own API will edit
the documentation of the thing it is changing.

Also in this commit: `@kontsedal/olas-dom` was built, measured and dropped before commit —
see `decisions/no-vanilla-adapter.md` and the earlier entry today.

## [2026-09-21 09:50] ingest | 0.9 review findings — duplicate writes, hydration, and two wrong messages

Sixteen findings from an external review of the 0.9 tree. Fourteen reproduced and were fixed;
one did not reproduce against the installed React and was fixed anyway for the peer floor;
the rest were filed to `BACKLOG.md`.

**The queue could write a mutation twice, three ways.** All three sat in
`@kontsedal/olas-mutation-queue` and all three are now closed in `plugin.ts`, pinned by four
tests.

The first is the one a user reaches by hand. A `persist: true` run that fails keeps its
entry on disk for a cross-load replay, which is the design. The user does not wait for the
reload — they press the button again. That retry is a fresh `runId`, so its success dropped
its own entry and left the first one, and the next page load placed the order again. A run
that succeeds now also drops the entries left by earlier runs of the same logical operation
that settled in error. Identity is `dedupeBy` when configured, otherwise the `mutationId`
plus the JSON form of the variables — a retry re-submits the same variables, a different
operation carries different ones. Only settled runs are eligible, so a concurrent identical submit keeps
its own entry.

The second was in the `dedupeBy` path the first one reuses. A collapsed enqueue writes no
entry, and its settle still deleted `event.runId` — a key that was never written — leaving
the owner's entry on disk after the collapse had already succeeded. Every settle branch now
resolves through `runAlias` to the entry that exists.

The third needed no user at all. `replayEntry` called the registered mutate with no check on
what this tab was already running, so an `online` event or a `replayNow()` landing inside the
enqueue→settle window replayed a live request. `inFlightRuns` now covers that window.

**Core's comment about `attempt` was wrong, and had been for a while.** `mutation.ts` said
retries within `runWithRetry` bump `attempt`. They do not: one enqueue fires per run, always
with `attempt: 0`, and the retry loop re-invokes `spec.mutate` under the same `runId` emitting
nothing. The `MutationEnqueueEvent` doc said the same thing and now says the truth, which
matters because it is the contract a third-party plugin would build an attempt counter on.
The queue always kept its own tally, so nothing behavioral changed.

**`dispose()` could hold the cross-tab replay lock forever.** `waitForOnline` sits inside
`withReplayLock`, and a tab that disposed while offline never resolved it. The lock, and the
`online` listener the wait had registered, survived until a network that might never return.
`onlineWaiters` releases both.

**A returning visitor's first client render disagreed with the server.** `usePersisted` reads
its adapter during controller construction and `localStorageAdapter` reads synchronously, so
theme, bookmarks and reading progress were in the signals before `hydrateRoot` ran — while
the server, with no localStorage, had rendered the defaults. React answers a mismatch by
discarding the server's DOM, which is the entire cost the SSR pass was paying to avoid. It
only bites a returning visitor, which is why every first-visit test passed.

The fix is in the renderer, not the controller: `examples/reader-ssr/src/App.tsx` holds the
three values back for one render behind a `useHydrated` built on `useSyncExternalStore`'s
server-snapshot argument. Written up in `pitfalls/persisted-state-breaks-hydration.md`,
because the shape generalizes to anything the server cannot see, and repeated in both
READMEs.

**Nothing in the repo had ever hydrated real markup.** SSR is a headline feature and the
tests covered each half separately — `dehydrate`/`hydrate` in core, the boundary's lifecycle
in react, the cache hit without React in the reader-ssr example. None put `renderToString` and
`hydrateRoot` on the same HTML, which is the only place a mismatch surfaces.
`packages/react/tests/ssr-hydration.test.tsx` does, watching `onRecoverableError`. It carries
a control case — the same markup against a root with no hydrated state — because an
assertion that something never fires is worth little until you have watched it fire.

**Two error messages sent readers the wrong way.** `@kontsedal/olas-entities` cleared the
store in `dispose()`, and that clear is indistinguishable from "never registered" to the
registration check, so every post-dispose call reported a missing `entitiesPlugin([...])`
entry that was right there. A `disposed` flag now answers first. Separately,
`clearPersisted()` with no prefix deleted every key the adapter enumerated — and the default
adapter is `localStorage`, shared by the origin, so a "log out" took analytics ids and
consent records with it. It now requires a non-empty `prefix` or an explicit `{ all: true }`.
That function had zero tests and now has six.

**The flagship example broke a rule it exists to teach.** `CardDetail.tsx` returned early
above seven hooks, and `CardTile.tsx` promised in its own docstring that "a label rename
anywhere bubbles here without a refetch" while reading through `entities.get`, the documented
NON-reactive peek. Both fixed: the panel takes its card as a prop so the branch lives one
component up, and labels, assignees and comment authors read `entities.signal` through small
per-id components — one component per id, because a `use(...)` inside a `.map` changes the
hook count with the list. `SubtasksRow` had `key={idx}` on a list with a delete; it now keys
off the item's `Form` handle identity, and a DOM test watches node identity survive a
removal.

`biome.json` disables `useHookAtTopLevel`, `useExhaustiveDependencies` and `noArrayIndexKey`,
which is why nothing caught two of those. Filed.

**`useSuspendOnHidden` never let go.** It suspended on hidden and removed its
`visibilitychange` listener on cleanup — the only thing that would ever have resumed the
controller. Unmounting a hidden tab's subtree stranded it permanently; swapping the
`controller` argument stranded the outgoing one. The cleanup now resumes whatever it is the
reason for suspending, and leaves anything else alone.

**One finding did not reproduce.** The router's unguarded `useLayoutEffect` warns during a
server render on React 18, and React 19 — what this workspace installs — dropped that
warning. The isomorphic swap went in anyway, since `react: ">=18"` is the declared peer
range, and the new `packages/router/tests/ssr.test.tsx` says plainly that its `console.error`
assertion cannot fail here today.

**One finding was a doc, pointing the wrong way.** `@kontsedal/olas-zod` documented an
`extraValidators` path of `'tags'` as matching the `FieldArray` as a whole. It never did — a
path names a position in the schema, an array adds no segment, so the walker hands the same
path to every element. The doc moved to meet the code, because the alternative needs a
`FieldArrayValidator`, a different signature the type cannot express. Pinned.

Filed to `BACKLOG.md` rather than fixed: the queue's lack of retryable/non-retryable error
classification, its two untested replay paths and its `Date.now()` seed; cross-tab's absent
causality and three neighbours; three sharp edges in persist; the plugin contract's hardcoded
knowledge of its own plugins; `useQuery`'s missing `select`, the absent `useInfiniteQuery`,
four smaller React defects, and the two exports with no consumers; three gaps in realtime;
five in entities; two in zod; kanban's decorative `isPaused`; and the three biome rules.


## [2026-09-22 09:30] ingest | three query-engine defects: serial-after-reset, fetcher-originated abort, own `__proto__`

Three suspected defects in `@kontsedal/olas-core` were handed over as hypotheses. All three
reproduced, and each now has a failing-first regression test in
`packages/core/tests/regressions.test.ts` (seven tests) and
`packages/core/tests/structural-share.test.ts` (seven tests).

**A `serial` mutation ran two writes at once, one `reset()` away.** `reset()` aborts the active
run and clears `serialActive`, so the next `run(...)` opens a new queue — and the abandoned run's
continuation still fires when its abort lands. It called `advanceSerialQueue()` on whatever queue
it found: A, `reset()`, B, queue C meant A's abort started C alongside the pending B, and B's own
completion then cleared the lock while C was still running. Both halves of the serial guarantee
broke at once, in a mode whose entire purpose is ordering. Continuations now carry the generation
they were scheduled under, `reset()` bumps it, and a stale continuation returns without touching
the queue. `dispose()` needs no bump — a non-detached dispose makes every later `run(...)` reject,
and a detached one deliberately drains under its own generation. Written up in
`flows/mutation-concurrency.md`.

**An `AbortError` from the fetcher read as a supersede, and wedged the entry.** Every engine-side
cancellation bumps `currentFetchId` or sets `disposed` before aborting the controller, so "is this
still the current fetch" is the test that separates the two cases — and the old single check fused
them, rethrowing any `AbortError` with no state written. A fetcher aborting itself (an
`AbortSignal.timeout`, an axios cancel token) therefore left `isFetching: true` with nothing coming
to clear it: `root.waitForIdle()` never resolving during SSR, `firstValue()` never settling under
Suspense. The current fetch's abort now settles as a failure, which is also what §5.6 implies by
dropping errors from *outdated* fetches only. `entities/entry.md` carries the distinction and the
order of the checks.

`InfiniteEntry` has the same defect in both of its loops, verified by reproduction — the status
repair in its `finally` is gated on `!isFetching`, which nothing clears, so it does not fire.
Filed to `BACKLOG.md` rather than fixed: the infinite loops settle state inline with no
`applySuccess` / `applyFailure` to route through, and its three directions each want a different
settled shape.

**`out[key] = value` is wrong for one key.** An own `__proto__` — which `JSON.parse` produces from
any API echoing user-controlled keys — hits `Object.prototype`'s accessor on assignment: the
rebuilt object's prototype was replaced, the property was never created, and the payload's own data
became readable through the prototype chain of a cached value handed to every subscriber. The
comparison side had it twice over: `prev[key]` returned the prototype object, and `key in prev` is
true for `__proto__` on every plain object, so "prev lacks this key" answered false exactly where
it mattered. New pitfall page `pitfalls/proto-key-assignment.md`, which also records that the
rebuild now keeps the prototype both sides shared — a `Object.create(null)` payload used to come
back wearing `Object.prototype`.

**`writeData`'s comment said both things.** `314aa28` (0.7.0) made `write` supersede an in-flight
fetch; `e8933dd` (0.7.2) rolled that back into `replace` and added a paragraph saying so, directly
below the paragraph saying the opposite. The code never superseded, `SPEC.md` §5.5 never said it
did, and the reconciled comment now says what runs. Two neighbours repeated the stale rule and are
corrected: `Query.invalidate`'s docstring, the rebase comment in `Entry.setData`, the
`canonical-vs-optimistic-writes` decision page's last bullet, and the premise sentence of the
`[planned]` catch-up-refetch backlog item.

Verified: `pnpm test` (951 tests in 65 files, 14 of them new), `pnpm test:coverage` against its
thresholds, `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm publint`, `pnpm attw`,
`pnpm smoke:dist`, `pnpm wiki:lint` (0 errors), `pnpm prose:lint`.

## [2026-09-24 14:00] ingest | 1.0 review, W0: infinite self-abort, keepDataWhileDisabled, isSelected identity

This opens the 1.0 work. The review and the approved plan live outside the repo (the session plan file). The decisions it records are:
- a separate root handle (`root.api`);
- plugin host v2;
- a required `id` on shared queries and defined mutations;
- ESM-only.

The later ingests cite them as they land.

**`InfiniteEntry` had `Entry`'s fetcher-originated `AbortError` wedge**, filed to BACKLOG in the previous ingest. The fix is the `Entry` split, applied in both loops. A superseded or disposed request rethrows and writes nothing. An abort from a request that is still current comes from the fetcher, so it settles inline as a failure and skips the retry policy. The BACKLOG item is removed, and `entities/entry.md` now covers `query/infinite.ts` and records the split.

**`keepDataWhileDisabled` was a silent no-op on infinite queries.** `createInfiniteUse` accepted the option and never read it. Retained pages now cover both transitions, a key change and a disable. `flat` flattens the retained pages through the spec's `itemsOf`. Before this change, `flat` read the new entry and went empty under `keepPreviousData` while `pages` still showed the old key.

**`selection().isSelected(id)` minted a computed per call.** A `use(sel.isSelected(id))` in a row's render therefore re-subscribed every render. The computeds are now cached per id behind a `WeakRef`, with a `FinalizationRegistry` dropping the dead keys.

**Hover docs.** Three kinds of fix:
- The botched "Was `createQuery(ctx, …)`" migration sentences (a find-and-replace ate `ctx.use` and friends) are deleted from `query/bind.ts` and `forms/bind.ts`. Migration history belongs in MIGRATING, not in hover text.
- Four JSDoc blocks sat on the wrong symbol: `QuerySpec`, `InfiniteQuerySpec`, `Mutation` and `formFromZod`. Each is moved onto its own declaration.
- An orphan doc line in realtime is removed.

## [2026-09-24 15:30] ingest | 1.0 W1a: the root handle

`createRoot` returns `{ api, bindQuery, inject, dispose, suspend, resume, dehydrate, hydrate, waitForIdle, debug }`, frozen. Removed:
- `ROOT_METHODS`
- the conflict check
- the `{ value: api }` wrapper for primitive apis
- `applyDehydratedEntry`, replaced by `hydrate(state)`
- `__debug`, now `debug`
- react `useController`

The reasoning is in the new page `decisions/root-handle-separate.md`.

`ControllerInstance.resolveScope(scope, caller)` now backs both `ctx.inject` and the new `root.inject`, so the scope walk and its memo live in one place. `createTestController` takes the new `TestControllerOptions`: `props` is optional for a `void` controller, and `plugins`, `scopes` and `hydrate` pass through.

1,238 call sites were rewritten by `scripts/codemods/root-api.ts`, a ts-morph codemod driven by the type checker. It runs in two modes. The first detects the 0.x root type (it has `__debug` and `applyDehydratedEntry`). The `--after` mode catches accesses that the first pass saw only through `as unknown as Api & { dispose(): void }` casts. Those casts were stripped first so the real type flowed. The regression test "root-controls conflict disposes the tree (R-L2.5)" is deleted, because the conflict can no longer occur. The controller test that asserted reserved names throw now asserts the opposite.

Wiki pages that still describe the intersection get rewritten in the W6 docs pass: `flows/use-root.md`, `modules/controller.md`, `modules/react.md` and `entities/controller-instance.md`.

## [2026-09-24 16:40] ingest | 1.0 W1b/c: required id, typed meta, { signal, deps }

- `QuerySpec.id` and `InfiniteQuerySpec.id` are required, and `defineQuery` asserts a non-empty string at runtime. The anonymous-query branches are gone from `dehydrate`, the three plugin emitters, the fetch-success closures and the hydration key.
- `meta?: QueryMeta` and `meta?: MutationMeta` are empty, augmentable interfaces. cross-tab and mutation-queue declare `crossTab` and `persist` through `declare module`.
- `MutationSpec` drops `name`, `mutationId` and `persist` in favour of `id` and `meta`. A mutation with an `id` now reports enqueue and settle to plugins, and the events carry `meta`. mutation-queue filters on `event.meta.persist`. `QueryClientPluginApi` gains `deps`, so its replay can pass `{ signal, deps }`.
- `defineMutation` takes a `MutationDefinition` with no hooks and no implicit persist, and brands the value non-enumerably. `createMutation(ctx, def, hooks)` is the new overload.
- `ErrorContext` has `queryId` and `key`. `MutationDisposedError` has `mutationId`.

The reasoning is in `decisions/required-id-and-meta.md`.

`scripts/codemods/identity-meta.ts` rewrote 376 call sites syntactically. It moves a property under `meta` in place rather than removing and appending, so no two edits can overlap. It also gives an id-less query a `<file>/<line>` placeholder id. Placeholders that landed in example sources were renamed by hand.

Seven tests that pinned removed behaviour were deleted:
- anonymous queries skipped by plugins and by dehydrate;
- the removed `crossTab: 'infinite' | 'both'` values;
- `persist` without an id.

The SSR registration-order test now always uses ids.

The global query registry still exists and still warns on a duplicate id. W2 replaces it with per-root lookup.

## [2026-09-24 17:20] ingest | 1.0 W1d: engine-owned defaults, a reusable engine

`queryEngine({ defaults })` is now the only place for root-wide query defaults. The following are gone:
- `RootOptions.defaultQueryOptions`
- the flat `RootOptions.refetchOnWindowFocus` / `refetchOnReconnect`
- `QueryEngineOptions.plugins` and `QueryEngineOptions.hydrate`

The precedence was contradictory. The engine docstring said engine values win, but `client.ts` resolved `defaults.X ?? opts.X`, so a root-level `defaultQueryOptions.refetchOnWindowFocus` beat the engine's shorthand. With one location, there is no precedence left to get wrong. `DefaultQueryOptions` is renamed `QueryDefaults`. `QueryClient` takes `defaults` directly.

**The engine's "adopted once" guard is removed.** It existed because the engine used to own plugin instances. It made `HydrationBoundary` throw under StrictMode: the remount effect rebuilds the root from the same options object, and therefore from the same engine. This was blocker A1 of the 1.0 review. `hydration-boundary.test.tsx` "(b2)" pins StrictMode + engine + hydrate, and `query-isolation.test.ts` pins that one engine shared by two roots gives two independent caches.

Stateful plugin instances passed twice are still shared between the two roots. Plugin host v2 (W2) moves per-root state into `setup`, which closes that.

`scripts/codemods/engine-defaults.ts` moved 34 option sites. The tests "defaultQueryOptions wins over the flat shorthand" and "an engine belongs to exactly one root" are deleted; the rules they pinned no longer exist.
