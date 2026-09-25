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

## [2026-09-24 19:30] ingest | 1.0 W2: plugin host v2, and the four plugins ported

**New modules:**
- `packages/core/src/plugin/types.ts`: the public contract.
- `packages/core/src/plugin/host.ts`: `PluginSet`, which does setup, delivery, isolation, middleware composition, `track` and disposal, plus `definePlugin`.
- `packages/core/src/query/mutation-registry.ts`: the global `defineMutation` registry, moved out of the deleted `query/plugin.ts`.

The reasoning, and the list of what the old `QueryClientPlugin` got wrong, are in `decisions/plugin-host-v2.md`.

**Where things moved:**
- **`createRoot` runs plugin setup, before the factory.** The order is: client created, plugins set up, plugin-provided scopes seeded, `RootOptions.scopes` seeded (so they win), then construct. A setup throw disposes earlier plugins in reverse, then the client.
- **`root.dispose()` order:** close delivery, dispose the instance, dispose plugins in reverse, dispose the client.
- **`root.waitForIdle()`** alternates between the client's idle wait and `PluginSet.pendingWork()` until neither moves.
- **`QueryClient`** lost `makePluginApi`, `callPlugin`, the three emitters, `applyRemoteSetData`, `applyRemoteInvalidate`, `setEntryData`, `subscribedKeysFor` and the `applyingRemote` flag. It gained:
  - `byId` and `refOf`;
  - `emitWrite` / `emitInvalidated` / `emitRemoved` / `emitActivity`;
  - `runFetch`;
  - `mutationLifecycle`;
  - `queryHost(origin)` / `mutationHost(origin)`.

  It also takes an `origin` parameter on every write and invalidate. `applyDehydratedEntry` and the hydration buffer carry `origin` too.
- **Entries.** The entries' fetchers take `(signal, attempt)`, and `InfiniteEntry` passes `attempt` in the page context, both for `wrapFetch`. `Entry.applyHydration` no longer calls `onSuccessData`; that call was the double hydration event.
- **`MutationImpl`.** It reports `start`/`success`/`error`/`cancel` through `MutationLifecycleHooks.emit` for every run, and threads `runId` into `runWithRetry` so `wrapMutate` sees it.

**Ports:**
- **cross-tab:** per-root state lives in setup. There is an `origins` / `optimistic` policy. Receiving uses `host.queries.write`/`invalidate`, so a remote invalidate refetches only when an entry is subscribed.
- **entities:** `createEntityStore` runs per root. `Entities` is a scope. Backprop goes through `host.queries.write`, with the plugin's origin so it skips its own writes. `invalidate` is renamed `remove`.
- **mutation-queue:** setup-scoped. It uses `onMutation`, `host.mutations.run`/`has`, `host.network` and a `MutationQueue` scope. `adapter` is renamed `storage`.
- **react streaming hydrator:** `onWrite` over committed sources.

**Also fixed on the way.** `query/focus-online.ts` removed its shared listeners from whatever `window` existed at uninstall time, and left its installed state stuck when there was none, which stranded the listener. It now remembers the target it installed on.

**Tests.** `tests/plugin.test.ts` is replaced by `tests/plugin-host.test.ts` (28 contract tests). The R-Q1.1 and R-Q3.6 regressions are rewritten onto `host.queries` and `WriteEvent`. Satellite tests are ported. The mutation-queue unit tests drive `onMutation` through a `directHooks` fake host, and replay tests wait with `root.waitForIdle()` (the startup replay is tracked). The kanban example now reads the store with `ctx.inject(Entities)` instead of threading the plugin through `deps`.

BACKLOG: the `isRemote` redundancy and "the plugin contract knows its plugins" items are removed. Two bullets of the entities item are resolved. New `[planned]`: persist inside `wrapMutate`, to close the queue's loss window.

968 tests. CI chain green.

Wiki pages whose `covers:` changed and still describe `QueryClientPlugin` get rewritten in the W6 docs pass: `modules/cross-tab.md`, `modules/entities.md`, `modules/mutation-queue.md`, `entities/query-client.md` and `flows/ssr.md`. A `flows/plugin-lifecycle.md` page follows there too.

## [2026-09-24 21:00] ingest | 1.0 W3: the ecosystem on the v2 host, and the `create*` renames

**Renames.** Every function that takes `ctx` and builds something is now named `create*`:
- persist: `createPersisted`. `localStorageAdapter()` is a factory, and `clearPersisted` takes only the options form.
- realtime: `createRealtimePatcher`, `createLiveStream`, `createConnectionState`.
- zod: `createZodForm`, whose `initial` also takes a tracked function (`packages/zod/src/index.ts:286-300`).

**router.** `createRouterAdapter()` returns `{ plugin, Bridge }` (`packages/router/src/adapter.tsx:55-63`). The plugin provides the three route scopes through `host.provide`, so `RootOptions.scopes` is no longer the install path.

**react streaming intake.** `installStreamingIntake` upgrades the bootstrap queue into a fan-out intake. The intake keeps every batch, and each installed root catches up on install. Before, a second boundary or a StrictMode remount's root replaced the forwarder, and the first root stopped receiving batches.

**mutation-queue.** Recording at `start` and writing at `start` are now two steps. `onMutation` records the entry in `unwritten`. `wrapMutate` writes the entry on attempt 0, before `next()`, so the entry is durable before the request goes out. A settle that arrives first drops the record.

**core.** `MutateContext.origin` is set for plugin-started runs. `MutationImpl` reported both `success` and `cancel` when an abort landed after `mutate` resolved. A `settledOutcome` flag now keeps the report to one outcome, pinned by `packages/core/tests/plugin-host.test.ts` ("an abort landing after the work finished still reports success").

**Tests.**
- New zod tests cover the tracked `initial`: a clean form re-seats, a dirty form keeps its edit, and `'always'` re-seats a dirty form.
- New mutation-queue tests show `mutate` waiting for the storage write, and a rejected write being reported while the run proceeds.
- The positional `clearPersisted` test is deleted.

BACKLOG: the `[planned]` "The mutation queue can persist before `mutate` runs" item is removed; it landed here.

CI chain green.

## [2026-09-24 21:40] ingest | 1.0 W4a: every form node is a ReadSignal; `submit` resolves a union

- **`Form<S>` and `FieldArray<I>` are `ReadSignal`s of their value** (`packages/core/src/forms/form-types.ts:108`, `:190`). `FormImpl` and `FieldArrayImpl` hold a private `value$` computed and delegate `value`, `peek`, `subscribe` and `subscribeChanges` to it, as `FieldImpl` does. The aggregate `computeValue` lost its brand branch.
- **`Form.resetWithInitial` is renamed `setAsInitial`.** `FieldArray` gains `set` and `setAsInitial`. The array branch of `FormImpl.applyPartial`, which cast to reach the internal `replaceInitialItems`, moved into those two methods.
- **`Form.submit` resolves `SubmitResult<R>`**, tagged `ok` then `reason` (`'invalid' | 'error' | 'busy' | 'disposed'`). `SubmitResult` and `SubmitOptions` are exported.

Wiki: new `decisions/forms-are-read-signals.md`. `pitfalls/field-value-shape.md` is deleted, because the trap it described no longer exists. `modules/forms.md`, `overview.md`, `index.md`, `pitfalls/fieldarray-factory-uses-initial.md` and the CLAUDE.md gotcha list are updated.

Tests: the `.value.value` sites in core, zod and kanban were collapsed at their tsc error sites. New tests cover the node-as-signal surface, `FieldArray.set` / `setAsInitial`, `Form.setAsInitial` through nested nodes, and the `SubmitResult` narrowing. 978 tests, CI green.

For the W6 docs pass: README, API.md (`:832`, `:905-915`), RECIPES, SPEC (`:846` cites the deleted pitfall) and the zod README still show `form.value.value`, `resetWithInitial` or `{ ok, data?, error? }`.

## [2026-09-24 22:30] ingest | 1.0 W4b: React hooks renamed and completed; aliases removed

**react (`packages/react/src/hooks.ts`).**
- `use` is renamed `useValue`.
- `useQuery` reads `isPaused` into its snapshot and returns `reset` and `cancel`.
- `useMutation` returns `mutate` (void, swallows the rejection) and `run` (the derived promise, so an ignored failure is unhandled). An aborted run fires no callback.
- `useField` and `useMutation` build their actions in a `useMemo` keyed on the target.
- The result types are named and exported.
- `KeepAlive` is removed.

**core.**
- `AsyncState` gains `cancel` and loses `promise`. `QuerySubscription<T>` is now `AsyncState<T>`, and the infinite subscription type's duplicate `cancel` is gone. `LocalCacheImpl.cancel` delegates to `Entry.cancel`.
- `ctx.signal` and `ctx.computed` are removed from `Ctx` and from `instance.ts`.
- `selection` is renamed `createSelection`, and `UseOptions` is renamed `QuerySubscriptionOptions`.

**Codemod.** `scripts/codemods/react-hooks.ts` does the renames through the language service. One finding for W15's codemod package: `rename()` on an un-aliased import specifier renames the exported symbol, so every importer in the project changes in memory at once. The script must save every changed file, not only the file it is visiting. The first run saved one file per pass and silently dropped the rest.

**Tests.**
- New `packages/react/tests/hooks-surface.test.tsx` covers `mutate` failing into state with no unhandled rejection, `run` resolving and rejecting, the superseded run firing no callbacks, stable action identities, and `useQuery`'s `cancel`.
- New `LocalCache.cancel` test in `packages/core/tests/cache.test.ts`.

Wiki: `modules/react.md` (surface, subscription, a new `mutate`/`run` section), `flows/use-root.md` (the root handle, `useRoot` returns `root.api`, the `useController` section replaced), `overview.md`, `modules/query.md`, `modules/controller.md`, `index.md` and `pitfalls/persisted-state-breaks-hydration.md`.

## [2026-09-24 23:15] ingest | 1.0 W4c: symbol brands; InfiniteQuery peek / write / replace

**Brands.**
- New `packages/core/src/brand.ts` holds three `Symbol.for` keys, `BRAND`, `PHANTOM` and `INTERNAL`, none exported from the package.
- `ControllerDef`, `Query`, `InfiniteQuery`, `QueryEngine`, `Scope` and the `defineMutation` result carry their kind under `BRAND`. The mutation brand is still non-enumerable, and `MUTATION_DEF` / `MUTATION_BRAND` are gone. Phantom types moved to `PHANTOM`. The engine's `options` and `create` moved under `INTERNAL`, as `QueryEngineInternals`.
- `Scope.__id` is gone: the instance's `scopes` and `injectCache` maps key on the scope object.
- `olas-entities` stamps `'entity'` under `Symbol.for('olas.brand')` itself, since core does not export the key.
- The published `.d.ts` declares each key as a non-exported `declare const X: unique symbol`. The tree-shaking test still passes.

**Infinite parity.** `InfiniteQuery` and `InfiniteQueryActions` gain `peek`, `write` and `replace`, backed by the new client methods `peekInfiniteData`, `writeInfiniteData` and `replaceInfiniteData`. They follow `peekData` / `writeData` / `replaceData` exactly.

Wiki: `decisions/brand-markers-not-classes.md` is rewritten, because its argument for a string `__olas` no longer holds. Also updated: `entities/scope.md`, `entities/ctx.md`, `flows/query-subscription.md`, `glossary.md`, `overview.md`, `modules/query.md`, `modules/controller.md`, and a new infinite section in `decisions/canonical-vs-optimistic-writes.md`. That page's plugin vocabulary (`SetDataEvent`, `'set'`, `setEntryData`) is pre-v2 and joins the W6 rewrite list.

Tests: scope brand/identity (no internal keys in `Object.keys`), the entities brand, and three infinite parity tests. CI green.

## [2026-09-25 00:30] ingest | 1.0 W5: ESM only, stripped types, dist tree-shaking and size budgets

**Packaging.**
- All ten packages build `format: ['esm']` to `dist/*.js` and `dist/*.d.ts`, with `{ types, default }` exports, no `main` or `module`, and `engines.node >= 20.19`. The root `attw` script uses `--profile esm-only`.
- The mutation registry is a module-level `Map`; the `globalThis` slot is gone.
- `scripts/verify-dist.mjs` loads each entry through `import()` and `require()`, and bundles a controllers-only entry from core's dist with esbuild. It asserts no `olas.form` and no `QueryClient = class`, with a positive control.
- A new CI job, `dist-on-node`, runs the smoke on Node 20.19, 22 and 24. The main job moved to Node 22.

**Types.**
- `stripInternal` is on in `tsconfig.base.json`. `tsdown`'s declaration build honours it: core's type chunk went from 2,493 to 1,716 lines, and `QueryClient` and `CtxInternals` left the `.d.ts`.
- New `scripts/check-public-types.ts` (`pnpm check:public-types`, in CI) walks every entry's `.d.ts`. A type a public signature names that no entry exports fails it.
- The first run found `DebugEventBody`, `DefineControllerOptions`, `StandardSchemaV1Issue`, `StandardSchemaV1Result` and zod's `UnwrapZod`; all are now exported.
- The anonymous option and result types are named: `QuerySelectOptions` (which also gained `keepDataWhileDisabled`), `TimingOptions`, `EntityOptions`, the React props types, `OlasContext`, `UseValueOptions` / `UseValueSelectOptions` and `UseFieldInputOptions`.
- `isStandardSchema` and `ErrorContextInput` left core's index.
- A `useValue` finding: an intersection in the `select` overload's options (`UseValueOptions<T, U> & { select }`) broke inference inside the object literal, so `isEqual`'s parameters lost the type `select` gave them. Two plain object types fixed it.

**Bundle.**
- `FormImpl` and `FieldArrayImpl` set their brands in the constructor. Computed class-field keys kept the classes in every bundle built from `dist`.
- A controllers-only bundle from dist went from 8.62 to 6.35 KB gzipped, matching `src`. A negative test that reintroduced the class field made the smoke fail.
- `size-limit` budgets for thirteen entries are in `.size-limit.json` (`pnpm size`, in CI).

Wiki: new `decisions/esm-only-build.md`; CLAUDE.md's command list and CI line are updated. BACKLOG: the `[planned]` dist-retention item is removed, since it landed.

## [2026-09-25 01:40] ingest | 1.0 W8: API consistency — createField options, no ctx.session, durations, disabled subscriptions, typed useRoot

**core.**
- `createField(ctx, initial, { validators, validateOn })`. The public `FieldOptions<T>` lives in `form-types.ts`; the internal impl options type was renamed `FieldImplOptions` to free the name. `scripts/codemods/create-field.ts` rewrote 37 call sites.
- `ctx.session` is removed from `Ctx` and from `instance.ts`. Its two unique tests (an idempotent dispose, the deps override) moved to `ctx.attach`.
- `suspend({ maxIdle })` is renamed `suspend({ maxIdleTime })` with a named `SuspendOptions`. New `decisions/duration-naming.md` records the rule.
- `AsyncState.isEnabled`; `QueryDisabledError` (new `query/errors.ts`).
- `firstValue()` on a detached subscription waits through `AttachWaiters`, and repeats hand back the same promise through `FirstValueCache`. Both live in `query/use.ts`, shared by the regular and infinite subscriptions. Dispose now calls `sub.close()`, which rejects the waiters. `LocalCache.isEnabled` is a frozen constant, to stay tree-shakeable.
- New `decisions/disabled-subscriptions.md`.

**react.**
- `Register` / `RegisteredApi` type `useRoot()`. The kanban example registers its root, and its 17 `useRoot<AppApi>()` calls became `useRoot()`. That proves the augmentation merges against the built `.d.ts`.
- The suspense path warns once in development on a disabled query (`warnSuspendedWhileDisabled`). The package gained `src/__dev__.d.ts`.
- `HydrationBoundary` drops `hydrate` from the options it reuses after a `def` change.
- `useFieldInput` and `createOlasContext` have tests, and the reader-ssr Composer uses `useFieldInput`. New `decisions/typed-use-root.md`.

**BACKLOG.** Removed as landed or decided:
- the four React-adapter defects (fixed across W3–W8);
- `useFieldInput`/`createOlasContext`;
- suspense on a disabled query;
- infinite `peek`/`write` (W4c);
- the detached `refetch`.

The fine-grained `useQuery` item lost its now-fixed "fresh promise per suspended render" sentence.

## [2026-09-25 03:10] ingest | 1.0 W10: infinite-query parity

- **`InfiniteEntry`** (`packages/core/src/query/infinite.ts`):
  - seeds from `initialPages` / `initialPageParams` / `initialUpdatedAt`, and gains `applyHydration`;
  - `setData(…, { pageParams })` takes explicit params;
  - `parksOnOffline` / `settleParked` add the `offlineFirst` park to both loops;
  - reports through `EntryEvents`, with the counter shared via the new `nextFetchCauseId()` in `entry.ts`.
- **`QueryClient`:**
  - `devtoolsEntryEvents` builds one bundle for both entry kinds, and fetch events now carry `queryId`;
  - `InfiniteClientEntry` subscribes to focus and reconnect;
  - `emitWrite` takes `pageParams`, and the new `emitInfiniteWrite` sends every infinite write with them;
  - `dehydrate` walks `infiniteMaps`, and the hydration buffer (`HydratedSlot`) keeps `pageParams`;
  - `bindInfiniteEntry` adopts a validated payload (`infinitePayload`);
  - `applyDehydratedEntry` takes a `DehydratedEntry` and applies infinite payloads to bound entries.
- **Plugin types:** `WriteEvent.pageParams`, `WriteOptions` on `QueryHost.write` / `replace`, and `DehydratedEntry.pageParams`.
- **react streaming:** captures and delivers infinite entries with `pageParams`.
- **cross-tab:** the send and receive gates take either kind with `meta.crossTab`, and `setData` messages carry `pageParams`.

**Tests.**
- New `packages/core/tests/infinite-parity.test.ts` (8 cases).
- Streaming: the infinite round trip.
- cross-tab: three infinite cases, one of them pinning that the receiver stores the sender's params (`[0, 1, 2]`, where padding would give `[0, 0, 0]`).
- entities: a params-preserved assertion on backprop. Its vacuous "infinite queries are skipped" test is deleted.

Wiki: new `decisions/infinite-query-parity.md`. Updated `flows/ssr.md`, `entities/query-client.md`, `modules/cross-tab.md` and `modules/query.md` where they said infinite queries were unsupported.

BACKLOG: the four infinite items (SSR, `offlineFirst`, cross-tab, devtools) are removed. Snapshot rebase stays.

Bundle cost: infinite parity added about 0.9 kB brotli to core's queries entry (14.95 → 15.84 kB) and to "everything" (20.34 → 21.23 kB). The budgets were raised on purpose, to 16.6 kB and 22.3 kB. The controllers-only and forms entries did not move.

## [2026-09-25 04:20] ingest | 1.0 W11: dogfood the plugin contract — query-cache persistence, test plugins, tracing, authoring guide

**persist.**
- `StorageAdapter`, `LOCAL_STORAGE` and `localStorageAdapter()` moved to the new `storage.ts`, and `index.ts` re-exports them, so the new plugin module imports them without a cycle.
- New `query-cache.ts`: `persistQueryCachePlugin` and `restoreQueryCache`. It augments `QueryMeta.persist`. The rules are in `modules/persist.md` ("The query cache"):
  - canonical writes only;
  - gc drops the entry;
  - sync restore in `setup`;
  - async restore fills only unbound keys and is `track`ed;
  - `buster`, `maxAgeMs` and the shape check on restore.

**core `/testing`.** New `test-plugins.ts` with `mockFetchPlugin` (`wrapFetch` keyed by query id) and `createPluginRecorder`, re-exported from `testing.ts`.

**examples/kanban.** New `src/tracing.ts`, a `tracingPlugin` that times fetch and mutate attempts through middleware and provides a `Traces` scope. It is installed first in the root and in the test harness; `tests/tracing.test.ts` covers it.

**Docs.** New `PLUGINS.md`, the plugin authoring guide: the contract, the host and hooks, four plugin shapes, a ten-point checklist, and testing.

**Tests.** `packages/persist/tests/query-cache.test.ts` (9), `packages/core/tests/test-plugins.test.ts` (4), `examples/kanban/tests/tracing.test.ts` (1).

**Wiki.**
- `modules/persist.md` is rewritten around both persistence paths.
- The W3 `create*` renames (`createPersisted`, `createRealtimePatcher`, `createLiveStream`, `createConnectionState`, `createZodForm`) are applied across the wiki pages that still used the `use*` names.
- `modules/zod.md` shows the tracked `initial`.
- `modules/controller.md` mentions the test plugins.

## [2026-09-25 07:40] ingest | 1.0 W9: engine assurance — property models, coverage gates, mutation testing, 29 bugs fixed

**How the work was done.** Five parallel agents wrote tests only, with `src/` off limits and each real bug reported rather than patched:
- core `query/`;
- the rest of core;
- devtools;
- the other satellites;
- `fast-check` property models.

Each bug was then fixed here, with a regression test confirmed to fail against the old source.

**New tests.**
- About 600 coverage tests (`packages/*/tests/coverage-*.test.ts*`).
- Three property files in `packages/core/tests/property/`, at 1,000 runs per property.
- The coverage pass took the suite from 1,017 to 1,549 tests, and coverage from 89.5% lines / 76.5% branches to 99.6% / 95.7%.

**Bugs fixed.**
- **core engine:**
  - hydration rebases live snapshots (`Entry` and `InfiniteEntry`);
  - an infinite canonical write rebases;
  - infinite paging flags follow the owning request;
  - a mutation that fails in the abort gap reports `'error'` and rejects with `AbortError`;
  - `serial` queued runs count toward `waitForIdle`;
  - a disposed pending mutation goes `'idle'`;
  - `resume()` honours a disabled `enabled`;
  - retained `flat` without `itemsOf` equals `pages`;
  - `root.hydrate` checks the payload version through the new `QueryClient.hydrateLive`.
- **core forms:**
  - aggregate `isValid` holds while validating (`holdWhileValidating`);
  - a rejected form or array validator is an error;
  - a no-op `remove` / `move` leaves the array clean.
- **zod:** a default under optional/nullable; a function default; numeric enums.
- **realtime:** the `rafFlush` fallback timer leak.
- **entities:** `update` re-walks bound entries (new `absorbNested` for unbound ones).
- **mutation-queue:** dispose wakes the backoff sleepers.
- **devtools:**
  - the tree count;
  - the pending rollup;
  - the per-tab filter debounce;
  - storage reads inside a `try` in the launcher.

**Removed.** Dead code: `isField`, `LifecycleList.size` and `QueryClient.inflightCount`. The `Query.write` TSDoc now names the `'write'` source.

**Gates.** `vitest.config.ts` thresholds: global, core, and one per satellite. Stryker config added (`pnpm mutation`, `vitest.stryker.config.ts`), and outputs are gitignored.

**Mutation testing.** The first Stryker run over `query/{client,entry,infinite,mutation}.ts` and `controller/instance.ts` scored 76.5%. Five agents, one per file, triaged the 815 surviving or uncovered mutants into GAP, EQUIVALENT, NOT-WORTH and BUG. They wrote 167 tests for the 400 GAP mutants in `packages/core/tests/mutants-*.test.ts`, and checked every kill against a mutated scratch copy. The second run scored 87.8%. Per-file numbers and the classes are in `decisions/engine-assurance.md`.

The triage found seven more engine bugs, each fixed with a regression test confirmed to fail on the old code:
- `dispose()` / `reset()` inside `onMutate` did not cancel the run. The handle is now registered before `onMutate`.
- An `AbortError` from `mutate` itself counted as a cancellation. Only the run's own signal makes one now.
- A lifecycle handler that changed the controller's state did not end the `suspend` / `resume` pass.
- One `online` event spun without end while `navigator.onLine` read false. `focus-online.ts` now dispatches over a snapshot.
- An outdated fetch rethrew its own error, which reached `onError` through `invalidate()` and rejected `prefetch()`. `Entry` and `InfiniteEntry` now throw the supersede.
- A `prefetch()` in flight at dispose armed a gc timer afterwards. A late `release()` is inert once the entry is disposed.
- An infinite page request left `isLoading` stuck after a write filled the first load. A page request clears it when it starts.

**Benchmarks.** `packages/core/bench/engine.bench.ts` and `pnpm bench` (`vitest bench --run`) land here, ahead of W15: signal fan-out, 10,000 observed subscribers on one entry, a fetch cycle, structural sharing over a large payload, and a 500-field form. They never gate CI. The baselines against other libraries follow in W15.

Two harness findings: `mergeConfig` concatenates `include` arrays, so `vitest.stryker.config.ts` had been running every package's tests; and deleting a live run's sandbox turns the rest of the run into false survivors.

Wiki: `entities/mutation.md`, `flows/mutation-concurrency.md`, `entities/entry.md`, `entities/controller-instance.md` and `entities/query-client.md` describe the fixed behaviour. BACKLOG gains two ideas from the triage: a throwing `retry` / `retryDelay` callback wedges `isFetching`, and `ctx.debug` while suspended sends no devtools event.

**Wiki.**
- New `decisions/engine-assurance.md`.
- New `pitfalls/node-localstorage-shadows-jsdom.md`, a trap two agents hit independently.

**BACKLOG.** One new idea: a no-op field reset hides a form-level error.

## [2026-09-24 21:30] ingest | 1.0 W12: Vue and Svelte adapters, fine-grained React hooks, Preact, adapter parity

**New packages.**
- `@kontsedal/olas-vue` (`packages/vue/src/index.ts`): `olasPlugin`, `useRoot`, `useValue`, `useQuery`, `useInfiniteQuery`, `useField`, `useMutation`. A signal becomes a read-only `customRef` whose getter reads `peek()`, and the subscription ends through `onScopeDispose`. New `modules/vue.md`.
- `@kontsedal/olas-svelte` (`packages/svelte/src/index.ts`): `setRoot`, `getRoot`, `queryStore`, `infiniteQueryStore`, `fieldStore`, `mutationStore`. A signal satisfies the store contract as it is. New `modules/svelte.md`.

**react (`packages/react/src/hooks.ts`).**
- `useQuery` and the new `useInfiniteQuery` go through `useTrackedSnapshot`: getters record the fields read during render, and the subscription notifies only when a tracked field moves. A read after commit is live. Nothing read means every change notifies.
- `useValue`'s `isEqual` applies across a selector change, so an inline selector keeps its reference across a parent re-render.
- The React bundle budget rose from 2.7 to 3.2 kB, on purpose: the tracked snapshot and `useInfiniteQuery` measure 2.99 kB. New budgets: vue 0.9 kB (821 B) and svelte 0.85 kB (772 B).

**Preact.** `packages/react/tests/preact-compat.test.tsx` mocks `react` and its JSX runtimes onto `preact/compat` and runs the hooks there. It closes the BACKLOG verification item: the compat `useSyncExternalStore` shim keeps the fine-grained `useQuery`, compat `Suspense` retries `useSuspenseQuery`, and `SuspendOnUnmount` suspends on unmount.

**Adapter parity.** `packages/integration/tests/adapter-parity/` runs six scenarios through React, Preact, Vue and Svelte and asserts the same DOM: 24 tests. Breaking one adapter's change notification at a time failed that adapter's runs only. New `decisions/framework-adapters.md`.

**Test infrastructure.**
- `vitest.config.ts` gains two projects. `svelte` adds the compiler plugin and the `browser` resolve condition for the Svelte tests only, and `default` runs everything else. Coverage gates cover the two new packages.
- `vitest.stryker.config.ts` drops the projects.
- `biome.json` turns off the unused-variable rules for `.svelte` and `.vue` files, where the template uses what the script declares.

**Example.** New `examples/vue-tasks`: one controller with a query, an optimistic toggle, a canonical write and a validated form, in SFCs over the shared tokens. `typecheck` is `vue-tsc --noEmit`. It was driven in headless Chrome (optimistic toggle, rollback on a failed write, validation, add, filter, dark theme), and the pass moved the checkboxes onto the accent with `accent-color`.

**Wiki.**
- `modules/react.md`: the fine-grained section, `useInfiniteQuery`, a Preact section.
- `modules/examples.md`: five examples.
- `overview.md`: the package table.
- `decisions/no-vanilla-adapter.md`: it said React was the only UI adapter.

**BACKLOG.** Removed as landed: the Preact verification, the cross-adapter parity test, the Vue adapter, the Svelte adapter, `useQuery` re-rendering on `isFetching`, and the missing `useInfiniteQuery`. New ideas: a dev warning for a Vue hook called outside an effect scope; `svelte-check` for the `.svelte` fixtures.

For the W6 docs pass: README (adapters list), API.md (the React section gains `useInfiniteQuery` and the fine-grained rule), SPEC §16 and §20.10 (three adapters; `useQuery`'s tracked re-render), the React package README (`useInfiniteQuery`, Preact setup), and CLAUDE.md's package roster.

## [2026-09-24 22:40] ingest | 1.0 W13: `@kontsedal/olas-eslint-plugin`, and what it found in the examples

**New package** (`packages/eslint-plugin/`): six syntax-only rules, `recommended` and `strict` flat configs, a docs page per rule in `docs/`, and a README. New `modules/eslint-plugin.md` covers what each rule matches on and why.

**Fixes to the draft.**
- ESLint 10 sets `Program.parent` to `null`, not `undefined`, so every walk up the tree crashed at the root. `utils.ts` and two rules now stop at `!= null`.
- The public type is `OlasEslintPlugin`, built on ESLint's `ESLint.Plugin` and `Linter.Config`. Typed with `@typescript-eslint/utils`' `FlatConfig`, the configs did not fit `Linter.Config[]` or `defineConfig`; `tests/config.test-d.ts` pins the fit.
- `no-network-in-components` also matches `window.fetch`, `globalThis.fetch` and `self.fetch`.

**Scoped after linting the examples.** `tests/examples.test.ts` runs `recommended` over every example app's source and expects no findings. It found two false positives and four real bugs.
- `define-at-module-scope` flagged `defineController` inside `createAppRoot`. It now checks queries, mutations and scopes only. `definePlugin` was dropped too, because a plugin factory that takes options is the documented pattern.
- `optimistic-returns-snapshot` flagged any `setData` outside `onMutate`. It now flags a discarded snapshot only, since `setData(…).finalize()` is the only canonical patch a `LocalCache` has.
- **kanban:** `moveCard`, `reorderColumn` and `archiveCard` wrote optimistically without cancelling the board query first. A refetch in flight landed over the move. New regression test in `examples/kanban/tests/board.test.ts`, confirmed to fail on the old controller.
- **reader-ssr:** the composer patched `comments` with `setData` after the server accepted a comment and never settled it, so `hasPendingMutations` stayed true after every post. Fixed with `.finalize()`. New regression test in `examples/reader-ssr/tests/controller.test.ts`, confirmed to fail on the old composer.
- **kanban archive:** `setData(…).finalize()` became `write`. Its comment said infinite queries had no canonical `write`, which stopped being true in W4c.

**core: one engine bug, found by the reader-ssr regression test.** The test left two unhandled `AbortError` rejections. When a sync validator failed, a field's, form's or field array's validation pass returned before its async validators settled. The abort from the next pass or from dispose then rejected them with no handler attached. The new `abandonAsyncResults` in `utils.ts` aborts them and observes the rejections, at all three sites. Three regression tests in `packages/core/tests/regressions.test.ts` failed on the old code. `modules/forms.md` describes the rule, and the changeset is `abandoned-async-validators.md`.

**Tests.** `tests/rules.test.ts` has 62 RuleTester cases. Coverage is 99.2% lines and 95.6% branches, under the satellite gate added in `vitest.config.ts`.

**Wiki.** New `modules/eslint-plugin.md`. `pitfalls/no-invalidator-still-refetches.md` gains a "What catches it now" section. CLAUDE.md's roster lists the package.

**BACKLOG.** The eslint-plugin idea is replaced by the two rules that did not make the first cut: a fetcher or `mutate` that ignores its `signal`, and `/testing` imported outside tests. New idea: `LocalCache` has no canonical `write`.

For the W6 docs pass: README (tooling section), RECIPES (the optimistic recipe can point at the rules), and the `.cursorrules` file.

## [2026-09-24 23:50] ingest | 1.0 W15a: benchmark baselines, two teardown costs, and the security pass

**Benchmarks.** New `packages/core/bench/baselines.bench.ts` runs the same operations through Olas, raw `@preact/signals-core`, MobX and `@tanstack/query-core`, which are new core devDependencies. The results and the method are in the new `decisions/benchmarks.md`. The `svelte` vitest project sets `benchmark: { include: [] }`, so each bench runs once.

**Two teardown costs the first comparison exposed**, both with regression tests confirmed to fail on the old code:
- A settled request kept its `AbortController` as `currentAbort`, so the next refetch, a hydration, a cancel or dispose aborted it. Each abort built a `DOMException`: half of a 1,000-query root's CPU time. `releaseOnSettle` in `Entry` and `InfiniteEntry` now drops it. A fetcher's `signal` also no longer fires after its request has finished.
- `root.dispose()` armed and then cleared a gc timer per entry. It now calls the new `QueryClient.close()` before disposing the controllers.
- Together: 1,000-query dispose went from 6.9 ms to 0.37 ms, and the fetch-cycle gap to TanStack from 2.7× to 1.14×. One devtools test used `root.dispose()` to make a subscriber leave; it now detaches a child.

**Security pass.** A read-only review agent covered streaming SSR, every deserialization path, prototype pollution and the trust boundaries. It reproduced each finding against the built `dist`. Every finding is fixed with a regression test that fails on the old code. The record is the new `decisions/trust-model.md`, and the contract is the new SPEC §22, which also fills the §22 numbering gap.
- H1 (XSS): `createStreamingTransform` wrote a batch mid-tag. The new `HtmlBoundary` tokenizer holds a batch until a chunk ends between elements. New `pitfalls/stream-chunks-split-tags.md`.
- H2: the mutation queue replayed any registered mutation storage named, and replayed a key/contents mismatch forever. It now requires `meta.persist` through the new `host.mutations.get` and a matching key, rewrites migrated entries, and validates every field.
- M1–M3: new core `serializeForScript` (`JSON.parse` over a fully escaped string) for the streamed payload and for inlined state; `createStreamingHydrator({ nonce })`; reader-ssr's `renderPage` with function replacements.
- L1–L6 and L8: future timestamps in the stored query cache, async restore errors, `Form.set` own keys, `createPersisted` settling `ready`, per-entry hydration guards, the entities deep merge, cross-tab listener hardening with a new `validate` option, and a clobbered intake global.
- L7, the devtools URL hash, lands with the devtools work in W15b.

**Wiki.** New: `decisions/benchmarks.md`, `decisions/trust-model.md`, `pitfalls/stream-chunks-split-tags.md`. Security notes on `modules/react.md`, `modules/mutation-queue.md`, `modules/persist.md`, `modules/cross-tab.md`, `modules/entities.md`, `modules/forms.md` and `entities/query-client.md`. The teardown notes are on `entities/entry.md` and `entities/query-client.md`.

**Bundle budgets, raised on purpose for the security code:** react 3.2 → 3.8 kB (measured 3.54; the `HtmlBoundary` tokenizer and the script escaping), cross-tab 1.2 → 1.4 kB (1.31; the listener guards and `validate`), mutation-queue 3.0 → 3.3 kB (3.07; entry validation and the key check). The react figure is `import *`; a client that does not stream tree-shakes most of the growth.

**BACKLOG.** New idea: the signal wrappers cost about 30% over raw preact in fan-out.

For the W6 docs pass: API.md (`serializeForScript`, `StreamingHydratorOptions`, `MutationHost.get`, cross-tab `validate`), the React README's streaming section (the old Node `Transform` advice is unsafe), RECIPES' SSR recipe, and the performance numbers for the docs site.

## [2026-09-25 01:10] ingest | 1.0 W15b: devtools 8A — ring buffer, windowed lists, keyed tree, omnibox, plugin lanes

Built by an agent in a git worktree and merged as one commit.

**T8.2.**
- The timeline keeps a ring of the newest events, 10,000 by default. It is configurable through the new `maxTimelineEntries` prop on the panel and the launcher. `droppedEvents$` counts what the ring overwrote, the toolbar shows it, and Clear resets it. The three logs use the same ring.
- The controller tree is a keyed map, so an event costs constant time plus the path depth. Disposed nodes are pruned earliest-disposed first, greyed, and their `ctx.debug` values frozen at dispose time.
- `VirtualList` (`packages/devtools/src/virtual.tsx`, no new dependency) windows the tree, the timeline and the log lists. The tree renders as flat rows with `aria-level`.
- The stress test exposed a hotspot: the store scanned every pending mutation start on each dispose. The starts now sit in a trie by path, which took a 50,000-event run from 143 ms to 19 ms.

**T8.3.** An omnibox, focused with `/`, over a lazily built index with a per-item text cache (`search.ts`, `Omnibox.tsx`). Enter jumps to the match and highlights it.

**Plugin lanes, the lane half of T8.8.** Core already stamps `host.debug` events with the plugin's name. The timeline badges each such row and shows one chip per lane.

**Security L7** from W15a: the panel validates its URL-hash state before use. `url-hash-hostile.test.tsx` failed 5 of 12 cases on the old panel.

**Numbers.** Stress: 1,001 controllers and 50,000 events in 250-event frames, median frame 0.09 ms, total 19 ms, and doubling the events costs 1.8–2.0× the time. Coverage: 99.75% lines, 97.69% branches, 291 tests.

**Bundle budget, raised on purpose:** devtools 14.1 → 18.8 kB, measured at 17.88 kB. The growth is the search index and omnibox, the windowed list, the keyed tree and the ring. A build step strips the inline stylesheet's comments and whitespace (`scripts/minify-css.ts`), which won back 2.1 kB. The panel is a development tool, loaded behind the app's own dev gate.

**A browser smoke run found one more bug**, driving the kanban example with the panel open. Two queries with entries under the same key (the board query and the archive query, both at `["b1"]`) collided, because `DebugCacheEntry` had no query id and the panel keyed entries by key alone. The omnibox listed one label for both, with duplicate React keys, and the two shared a diff baseline. Core's `DebugCacheEntry` now carries `queryId` (set in `QueryClient.queryEntriesSnapshot`), and the store, the search index and the inspector key entries by `entryKey(queryId, key)` in `util.ts`. The store's `queryIds` map, which learned ids from events, is gone. Two regression tests in `store-foundation.test.ts` fail on the pre-fix code.

**Behaviour changes.** `DevtoolsStore`'s `tree$`, `cache$`, `mutations$`, `fields$` and `events$` are read-only signals. The store's default `maxTimelineEntries` rose from 500 to 10,000.

**Wiki.** The candidate page is promoted to `decisions/devtools-overhaul.md`, with 8A marked landed and 8B–8D kept as the open design. `modules/devtools-panel.md` is re-verified, and the package README is refreshed.

**BACKLOG.** The devtools-overhaul item points at the promoted page and drops T8.2, T8.3 and the lane half of T8.8. New ideas: first-party plugins emit onto their lanes, and the `DebugEvent` contract graduates to SPEC.

## [2026-09-25 02:00] ingest | 1.0 W15c: `@kontsedal/olas-codemod`

Built by an agent in a git worktree and merged as one commit. New package `packages/codemod/`: `npx @kontsedal/olas-codemod 1.0 [--tsconfig path] [--dry] [paths…]` migrates an app from 0.8 to 1.0 on ts-morph. New page `modules/codemod.md` describes it.

- **Seventeen transforms in `src/transforms/`**, ordered in `transforms/index.ts` with the type-driven ones first. They run while the code still resolves the 0.8 types, because rewriting to a 1.0 name removes those types. They cover every mechanical rename in the 1.0 table: the root handle (`root.api`), required ids and `meta`, the `{ signal, deps }` context, ctx primitives as free functions, `queryEngine({ defaults })`, the forms value shape, the `create*` and `useValue` renames, and the satellite option changes.
- **The edit engine** (`edits.ts`) collects position edits after a full read pass and applies them back to front, so nested matches keep both edits. `util/olas.ts` traces imports through specifiers and alias chains. Sites the tool cannot rewrite safely are listed as `file:line` TODOs, for example `ctx.session`, `applyDehydratedEntry`, custom plugins, and specs passed through a variable.
- **Three findings:**
  - ts-morph's `replaceWithText` turns CRLF into LF, so the engine writes each file with its own line ending.
  - tsdown's `banner` function caches its first result (a BACKLOG item).
  - A closed output pipe lost writes, so the CLI saves before printing.
- **Tests:** 51 in 19 files. Every transform runs on an input/output fixture against self-contained 0.8 stubs (`tests/fixtures/_types.d.ts`), plus an end-to-end CLI run over a multi-file project. Coverage is 100% lines and 98.2% branches, under a new satellite gate. `packages/codemod/biome.json` (`root: false`) keeps Biome off the byte-exact fixtures, and the root `tsconfig.json` excludes them too.
- **Checked on the real thing:** run over the four example apps from the 0.8 tag with the 0.8 types, it changed 208 sites in 47 files and reported 11 TODOs. The migrated controllers of three apps typecheck against 1.0, and the output matches this repo's hand migration apart from formatting.

**Left out, recorded in the README:**
- custom plugins, which need a redesign;
- cross-tab's new mirroring default, which is behaviour;
- unbound query helpers;
- `typeof root.x` and `root['x']`;
- a second run of `forms`, which is not idempotent.

**BACKLOG.** New ideas: run the codemod over the 0.8 examples in CI, and report the tsdown `banner` bug.

For the W6 docs pass: MIGRATING's 0.8 → 1.0 section opens with the codemod, and the README lists the package.

## [2026-09-25 09:30] ingest | 1.0 W6: the docs pass, and typechecked doc snippets

Every user-facing doc now describes 1.0, and a checker keeps their code compiling.

**The guard.** New `scripts/check-doc-snippets.ts` (`pnpm check:doc-snippets`, in CI after lint and in `ci.sh`) compiles every ts/tsx block in README, API, RECIPES, PLUGINS, MIGRATING and every package and example README against the package sources. New page `decisions/typechecked-doc-snippets.md` explains it.
- It builds one program per doc, so each doc's `AmbientDeps` and `Register` augmentations stay its own. A shared program had pushed RECIPES off the `ctx.deps` idiom, which is now restored.
- It has three annotations: `<!-- snippet-prelude -->`, `file=` and `nocheck`.
- **Finding:** a `declare module` augmentation alone does not load its module, because only an import adds a file to a TypeScript program. The checker passes every package entry as a root file.
- The first run found 913 errors in 172 blocks across 19 files: 0.8 names, the pre-handle root, pre-v2 plugin shapes, `queryId`, and React 18's global `JSX`. The final run is 0 errors in 159 blocks across 24 files.

**The docs** were split among eight agents by file, briefed from one shared sheet (the rename table, what 1.0 added, the checker rules and prose-rules.md):
- **README:**
  - adapters (React, Preact, Vue, Svelte), all fourteen packages, and a tooling section;
  - an SSR example that waits before rendering and gives the client root an engine;
  - two false claims removed: rollback on error is automatic, and the examples do not use the fakes.
- **API.md:**
  - `Root` as the handle, `queryEngine({ defaults })`, and every React hook;
  - `Plugins` and `Selection` sections, and short sections for Vue, Svelte, eslint-plugin and codemod;
  - `serializeForScript` and `MutationHost.get`;
  - 302 checker errors went to 0.
- **MIGRATING:** one "Upgrading from 0.8 to 1.0" section, in this order:
  1. the codemod first;
  2. the rename table by area, with a codemod column;
  3. the TODO fixes;
  4. what the codemod leaves to the reader.
- **RECIPES:** `create*` composables, `ctx.attach` in place of `ctx.session`, and new SSR and optimistic recipes. **PLUGINS:** every hook and host member checked against `plugin/types.ts` and `host.ts`.
- **Package READMEs:**
  - react: `useInfiniteQuery`, the fine-grained rule, Preact setup, and streaming without a hand-written Node `Transform`;
  - persist: `persistQueryCachePlugin`;
  - cross-tab: `origins` and `validate`;
  - also entities, mutation-queue, realtime, router, zod, devtools and the rest.
- **The rest:** `.cursorrules`, and the example READMEs.

**SPEC.** §13 is now "Plugins & persistence", with four subsections: 13.1, the v2 plugin contract; 13.2, cross-tab; 13.3, the mutation queue, the section eight citations already pointed at; and 13.4, persistence. No existing number changed. Elsewhere in SPEC:
- §16 documents React, Vue, Svelte and Preact.
- §18's non-goals no longer rule out the queue or entities.
- §19 lists the fourteen packages, their peers and ESM only.
- Every §20 listing is rebuilt from source.
- The phantom APIs are gone: `ctx.dynamicCollection`, `ctx.withDeps`, `debounce()` and `ParamCache`.

Where SPEC and code disagreed, SPEC now follows the code. Suspended controllers release their entries (§4.1, §4.2, §23). §20.3's "Style B" never compiled, and it is now the helper-parameter pattern. Citations elsewhere are repointed: §13 → §13.1, §13.3 or §13.4 where specific; §17.5 → §16.5; §5.7 → §5.2; §6.3 → §6.1.

**Found by the pass:**
- **`createField` literal inference, re-checked with tsc.** A bare `createField(ctx, '')` widens to `Field<string>`. The pitfall page and CLAUDE.md had said it gives `Field<''>`. With a `validators` array the literal does stick, and `createField(ctx, null)` is `Field<null>`.
  - The old type test was vacuous: `toMatchTypeOf<string>()` accepts both, and `expectTypeOf(x)` widens a literal as it infers.
  - `type-pitfalls.test-d.ts` now pins all three with `expectTypeOf<typeof x>()`.
  - `pitfalls/literal-type-narrowing.md` is rewritten, and so are the CLAUDE.md gotcha and the API.md line.
- **zod:** the `ExtraValidators` doc claimed `z.array(...).min(3)` is enforced on the parent. A probe showed a one-tag form reads valid. The doc, README and `modules/zod.md` now give the path-less root `.refine` workaround, and a new test pins both halves.
- **Stale hover docs** fixed, with a patch changeset (`hover-docs-1-0.md`):
  - cross-tab's infinite-query note and its `origins` rationale;
  - react's streaming examples, which put a `HydrationBoundary` on the server without an engine;
  - mutation-queue's serialization claims;
  - realtime's `'unknown'` fallback and `create*` naming;
  - core's `AsyncState` signal count, `DehydratedEntry.id`, `Ctx.use` and the §17.5 citation;
  - devtools' `use()`;
  - the example and test comments.
- **Five wiki citations into `mutation.ts`** had pointed at the wrong code for months: latest-wins, raceAbort (whose fix snippet is now current), devtools and examples. They are fixed. A BACKLOG item asks for a lint that can tell a drifted range from a right one.

**Wiki:**
- Rewritten to v2 vocabulary:
  - modules: cross-tab, entities, mutation-queue, controller, react, query, errors, devtools;
  - entities: query-client, controller-instance, entry, ctx;
  - flows: ssr, use-root;
  - decisions: canonical-vs-optimistic-writes;
  - also overview and glossary.
- `devtools-overhaul` and `plugin-host-v2` corrected in place.
- New: `flows/plugin-lifecycle.md` and `decisions/typechecked-doc-snippets.md`.
- `modules/examples.md`: findings 1 and 2 are marked resolved.

**Changesets.** Thirteen rewritten so the 1.0 CHANGELOG describes 1.0:
- `root-isolation-cache-identity` and `ctx-primitives-free-functions` described 0.9, `ctx.bindQuery`, `ctx.session` and the since-reversed "an engine belongs to one root";
- the rest named `scripts/codemods/*` or 0.8 APIs.

**BACKLOG.**
- A line now says every open item is deferred to 1.x.
- Removed as landed: the CRLF item, the realtime test gaps, the Web Locks tests, the `throttleMs` doc, the cross-tab reuse guard and the wiki citations.
- New:
  - realtime handler narrowing;
  - the server-side `HydrationBoundary` root leak;
  - zod array rules;
  - a cross-tab plus entities test and its default;
  - three devtools event gaps;
  - `ErrorContext.attempt`/`cause` and the `replace` asymmetry;
  - the unused query barrel;
  - the wiki-lint range check.
- A decision before the 1.0 publish: devtools shows an empty tree against the npm core, whose build strips every `__DEV__` emit site.
- A `defineController` generic for per-root deps.
- The two release items are `[planned]` for W7.

CLAUDE.md: the roster and the gotcha now use 1.0 names, and the doc-snippets command and CI step are added. Test count: 2,012 tests across 158 files.

## [2026-09-25 13:00] ingest | 1.0 W14: the docs site and the API reports

New page `decisions/docs-site.md` explains the site and the reports.

**API reports.** New `scripts/api-report.mjs` drives api-extractor through its programmatic API, one config per published entry built from `package.json` `exports`. It writes `packages/*/etc/*.api.md`: 15 reports, including core's `/testing`. `pnpm api:check` runs in CI after `check:public-types`, and `pnpm api:update` rewrites the reports.
- Four messages are turned off: `ae-missing-release-tag`, `ae-undocumented` (TSDoc coverage is a BACKLOG item), `ae-wrong-input-file-type`, and `ae-forgotten-export` on sub-paths.
- A forgotten export on a main entry fails the run.
- The script counts the warnings it prints, because `warningCount` includes the notices it silences.
- It pins `newlineKind: 'lf'`.
- api-extractor bundles TypeScript 5.9 and reads the 6.0 output.
- It found one real warning: core's `DebugEventMeta.seq` linked the unexported `DevtoolsEmitter`.

**The site.** VitePress in `docs/`, served under `/olas/`:
- **Written pages:** the home page and eight guides (getting-started, concepts, queries, mutations, forms, ssr, testing, performance), written by three agents from one brief. `pnpm check:doc-snippets` covers them: 233 blocks in 34 files, 0 errors.
- **Synced pages:** `scripts/docs-sync.mjs` copies RECIPES, PLUGINS, MIGRATING and every package README in, and rewrites their relative links, to site routes or to GitHub.
- **Reference:** `api-documenter` renders it from the doc model (383 pages), and the sync lifts each page's H2 into its title.
- **Fixes the build needed:** inline code is marked `v-pre`, because Vue read `{{ … }}` in JSX props as interpolation. The dead-link check stays on; only api-documenter's member links are exempt.
- **Scripts:** `docs:sync`, `docs:dev`, `docs:build` and `docs:preview`.
- **Workflow:** `.github/workflows/docs.yml` builds the site on every PR, and it deploys to Pages only from a manual dispatch with `deploy` ticked. Pages is not enabled, and nothing has been deployed.

API.md stays. The plan had the generated reference replacing its reference sections, but API.md carries checked examples and prose that api-documenter cannot produce. It is the narrative reference, next to the generated one.

**Found while writing the guides, all fixed:**
- **Streaming examples:** API.md, RECIPES and `flows/ssr.md` rendered a `HydrationBoundary` on the server. They now use a per-request root through `OlasProvider`, since a server render never runs the effect that disposes the boundary's root.
- **API.md, the mutation gotcha:** it said rollback is automatic only on abort. A failed run rolls back after `onError`.
- **SPEC:**
  - §5.2 gave the query `retryDelay` default as `1000`; it is exponential.
  - §5.5 listed a key change as aborting a shared query's fetch; that holds only for a local cache.
  - §4's "skips the network" holds only within `staleTime`.
  - §17.3 seeded with `write`, which leaves construction's fetch to land over the seed; it now uses `replace`.
  - §23's size rows read as cumulative.
  - The cross-tab clone note said a class instance throws; it arrives as a plain object. The README and hover doc said the same and are fixed too.
- **Wiki:**
  - `pitfalls/no-invalidator-still-refetches.md` said `write` supersedes an in-flight fetch. `replace` does (`client.ts:1555-1568`), and `write` has not since 0.7.2.
  - `decisions/ctx-primitives-are-free-functions.md` still listed `ctx.session`, `signal` and `computed` and the 8.2 KB figure; the figure is now 5.9 KB.
- **Hover docs:** `Form.submitError` misdescribed a validation failure. Two `streaming.ts` comments said Node 18. Both are in `hover-docs-1-0.md`.
- **Now documented:** `createRoot` does not check `deps` against `AmbientDeps` (use `satisfies`), and `waitForIdle()` does not count `createCache` fetches.

**BACKLOG.** New: the reference's case collision (`validator` / `Validator`), the `deps` check, and `waitForIdle` for local caches.

Before W7, the open questions for the user: enabling Pages and the first deploy, devtools against the npm core, and the peer ranges.

## [2026-09-25 14:30] ingest | development builds behind a `development` export condition; the docs site goes live

The user's decisions after W14: deploy the docs now, fix devtools against the npm core, and stop before the release.

**Devtools against the published core.** The release build inlined `__DEV__ = false`, so the npm core emitted no devtools events. `@kontsedal/olas-devtools` showed an empty tree against it, in 0.8 too, and the dev-only warnings never fired in an app.

Core, entities, persist, react and zod each now ship two builds from one `tsdown.config.ts` array:
- `dist/`, the default, with `__DEV__: 'false'`;
- `dist/dev/`, behind a `development` condition, with `__DEV__: 'true'`.

Neither build depends on `NODE_ENV` any more, so the root `build:dev` script is gone.

The user first chose an unguarded-`NODE_ENV` shape. Working it through showed that a `typeof process` guard defeats Vite's dev server, so they chose the condition instead (`decisions/esm-only-build.md`).

Checked:
- Vite 8's dev server resolves `dist/dev/index.js`, and `vite build` resolves `dist/index.js`.
- Node resolves the dev build under `--conditions=development` only.
- publint and attw are clean, and the size budgets are unchanged.

`pnpm smoke:dist` adds two checks. Every `development` target must load and export the same names as the default. Core must have the condition, its default build must emit no devtools events, and its dev build must emit some. Against the old code, the check fails with "core: no `development` export condition". A dev build built with `__DEV__: 'false'` fails with "the development build emitted no devtools events".

Docs: SPEC §23 "Devtools and production builds" is rewritten, and the devtools README and `modules/devtools.md` say which build the panel needs. New changeset `development-builds.md` (minor for the five packages). The BACKLOG item is removed.

**The docs site is live** at https://kontsedal.github.io/olas/. Pages was enabled (`gh api -X POST …/pages`), but `docs.yml` could not deploy: GitHub dispatches only workflows on the default branch, and the `github-pages` environment allows only `main`. With the user's choice, the built site went to a new `gh-pages` branch, Pages was switched to "Deploy from a branch", and a build was requested. The home page, a guide, a reference page and an adapter page load with no errors. BACKLOG has the `[planned]` switch back to the Actions deploy once `release/1.0` is on `main`. `decisions/docs-site.md` and `docs/README.md` say where the site is served from.

## [2026-09-25 15:10] ingest | the first GitHub Actions run of the 1.0 branch: two environment-dependent tests

Opening PR #3 ran `ci.yml` on Linux for the first time; until then the chain ran only locally, on Windows with Node 26. Two tests failed there and nowhere else:

- `packages/mutation-queue/tests/coverage-replay-lock.test.ts` used the real `navigator.locks`, which the CI job's Node 22 lacks. The Web Locks tests now install an in-memory lock manager with the semantics the plugin relies on (exclusive locks, `ifAvailable`, waiters in order), so they run the same on every Node version. With the fake's `ifAvailable` made non-exclusive, "the holder replays for it" fails, so the test still pins the lock.
- `packages/devtools/tests/store-stress.test.ts` asserted a doubled workload costs under 2.5× the single one, and a loaded runner measured 2.54× on linear code. The three ratio checks share `LINEAR_BOUND = 3`: linear work doubles, quadratic work quadruples, so 3 still catches the regression the test exists for.

The local `ci.sh` mirror runs on the machine's Node, so it cannot see a gap like the first one; the `dist-on-node` job covers only the dist smoke on 20.19, 22 and 24.

The second run passed both, and timed out three codemod tests at vitest's 5 s default instead: each builds a TypeScript program through ts-morph, 2–5 s locally and slower on a two-core runner under coverage. The first run had passed them, so they were timing-sensitive all along. `vitest.config.ts` now runs `packages/codemod/tests/` as a third project, `codemod`, with `testTimeout: 30_000`; every other suite keeps the default, so a hang elsewhere still fails fast.

## [2026-09-25 18:00] ingest | the 1.0 BACKLOG burn-down: every item implemented or dropped

The user asked for the backlog to disappear: implement what is worth it, and drop the rest. Eight worktree agents took one area each, then a TSDoc agent and a citation agent followed. The main session cherry-picked each commit, merged the conflicts (lists of dev-build packages; wiki line citations, resolved as ours + theirs − base), and ran the full chain on the merged head. `BACKLOG.md` now holds only the three release chores and a "Dropped" section with a reason for each. 2,232 tests across 176 files.

**A code review's three findings, all fixed:**
- **Throwing retry callbacks.** A `retry` or `retryDelay` that throws now fails that attempt with its error, in `Entry`, `InfiniteEntry` and page requests. Before, the query stayed `pending` and `waitForIdle()` hung.
- **A catch-up refetch discarded by `replace`.** It now fetches once more, if the entry was invalidated and still has subscribers, coalesced across a burst. `await invalidate()` waits for it. Every `replace` path calls `supersedeByWrite(hasSubscribers)`.
- **Zod rules.** `createZodForm` enforces object and array rules (`z.array(...).min(3)`, a root `.refine({ path })`) through one whole-schema validator that drops what a leaf already reports. It is installed only when the schema has such a rule (`decisions/zod-schema-rules.md`).

**Query engine** (`325ecf3`):
- `LocalCache.write` and `replace`;
- `ErrorContext.attempt` and `cause` set on cache errors;
- one rule for when a `replace` supersedes;
- infinite optimistic snapshots rebase on page-fetch success;
- `waitForIdle()` counts `createCache` fetches;
- `host.queries.invalidate` emits `cache:invalidated`;
- `cache:subscribed` and `cache:unsubscribed`, with a subscriber count in the inspector.

Two core budgets were raised to 17.5 KB and 23.5 KB.

**Controllers, forms, devtools** (`008d8ef`, plus `1648b9a`):
- `createRoot` checks `deps` against `AmbientDeps` (`TDeps extends AmbientDeps`), and so does `HydrationBoundary`'s `options`. Both are pinned by type tests in their own programs, since an augmentation reaches every file in a program.
- `ctx.debug` while suspended is sent on resume.
- Mutation devtools events use `id`; the devtools `MutationEntry` uses `mutationId`.
- `inspectorPollMs` is gone.
- A form-level run is the only writer of routed errors, so a no-op reset keeps them.
- `HydrationBoundary` warns on the server in development builds.
- The unused query barrel is deleted.
- The fan-out bench gap is mostly the order of cases in the bench file, not the wrappers (`decisions/benchmarks.md`).

**Satellites:**
- **entities** (`439b8c2`): the backprop finds an entity by id in each entry's current data, instead of following recorded paths; the walker is linear; the vacuous test pins its contract.
- **cross-tab + entities:** integration tests, and the default stays opt-in, measured.
- **mutation-queue** (`9ed7356`): `isRetryable`; `runId` as the tie-break for a colliding `seq`; the async-storage ordering test.
- **persist:** a marked envelope for version skew; `skipFirstDelivery` skips only a delivery made during `subscribe()`.
- **realtime** (`50a12c1`): `channel` accepts a signal; one shared connection listener per service, which fixed class-based transports; handlers narrowed per event.
- **vue:** a dev warning outside an effect scope.
- **svelte:** `svelte-check` over the fixtures.
- **eslint-plugin** (`3aef6c5`): `honor-abort-signal` (strict) and `no-testing-outside-tests` (recommended), eight rules in all.
- **examples** (`bcb0d74`, `85174e4`): a virtualized-table suite; kanban's suspend state shown in the UI; kanban's title check through `extraValidators`; the three React lint rules on for `examples/**`.

**Development builds** now ship for core, cross-tab, entities, mutation-queue, persist, react, vue and zod.

**TSDoc** (`02b45f2`): every public export has a doc comment, 53 were added, and `api:check` enforces `ae-undocumented`. Each overload needs its own comment.

**Member docs survive the declaration bundler** (`d0b11ef`). The bundler moved each one-line member doc onto the previous member's line, where TypeScript attaches it to nothing, so about 135 member docs were missing from the published types. The fix:
- sources write type-literal member docs as multi-line blocks (210 converted);
- `smoke:dist` fails on a stranded doc comment.

**Wiki citations:** `wiki-lint` now warns on a body citation whose range, give or take 2 lines, names none of the identifiers its sentence puts in backticks (`fb52a2f`). It flagged 76 citations on 26 pages. With a scratch comparison against each page's last commit, the pass changed 369 body citations and 76 `covers:` entries on 45 pages. Seven claims were rewritten, not just renumbered: `callargs-vs-keyargs`, `brand-markers-not-classes`, `query-subscription`, `devtools-causal-timeline`, `entry`, `scope` and `fieldarray-factory-uses-initial`. The check cannot see a range that moved onto code naming the same identifier, so a manual pass after a large refactor is still worth it. Its writing rule: a citation's sentence names at least one identifier from the cited lines.

**Dropped, with reasons in BACKLOG:**
- new products: the offline package, `bindField`, the Vite HMR plugin, the devtools browser extension, and the rest of the devtools overhaul;
- causal ordering across mutation ids, and a cross-tab causality guarantee;
- path-typed `fieldAt`, updater-replay rebasing, per-root deps generics, `replaceController`;
- timeline ordering by activity, shared example components, a src-to-src typecheck, the codemod CI job, the reference case collision;
- the tsdown upstream report, which is the maintainer's call;
- the wrapper fan-out cost, which turned out not to be the wrappers;
- `wiki-lint`'s automated candidate promotion, contradiction detection and confidence decay, which need judgment and stay manual lint passes.

## [2026-09-25 09:52] ingest | `HydrationBoundary` leaked the root of a render that never committed

**Reported:** a child that suspends before the boundary's first commit leaves the boundary's roots alive. The report's reproduction built two roots, disposed none, and saw their effects run after unmount.

**Confirmed, and wider than reported.** Measured against the old boundary under React 19.2:
- unmount while suspended: 2 roots, 0 disposed;
- suspend, resolve, unmount: 3 roots, 1 disposed;
- `useSuspenseQuery` under a `<Suspense>` above the boundary: 22 roots and 22 fetches in 200 ms, on the fallback forever;
- a `def` change in a suspended transition disposed the committed root during render.

**Fix** (`packages/react/src/context.ts`): a render acquires a root, and only the commit claims one. A retry of the same element reuses its root through the props object. The sweep disposes a root still unclaimed ten seconds after it goes idle. A failed claim rebuilds before paint, which StrictMode's remount already needed. The old root of a `def` change is disposed at the new root's commit.

**Tests:** six cases, (f) to (k), in `hydration-boundary.test.tsx`. (f) to (j) fail against the old boundary. Mutations confirmed that (k) and (b) pin the rebuild on a failed claim, and (i) pins the wait for idle.

**Pages:** `modules/react.md` (the `HydrationBoundary` section, rewritten), the new `pitfalls/render-phase-root-leak.md`, and moved citations in `flows/ssr.md` and `flows/use-root.md`. SPEC §16's SSR paragraph gained the contract. BACKLOG gained an `[idea]` for a dev warning on the retry loop that remains when the parent re-creates the element.

**Size:** react's bundle went from 3,538 to 3,798 bytes brotli, against a 3,800-byte budget.

## [2026-09-25 13:40] ingest | the 1.0 correctness pass: 41 review findings fixed

**Review.** Three reviewers read core's query engine, the rest of core, and the adapters with the satellites. They reported 41 findings, and a probe reproduced 39. Five were high: a disposed field hung `submit()`, an older fetch erased an invalidation, dehydrated keys changed hash through JSON, the mutation queue replayed superseded runs, and cross-tab opened a channel on servers, where `BroadcastChannel` reaches every request in the process.

**Fixes.** Five agents fixed them in parallel, one set of files each, with a failing regression test per finding first. The decisions worth knowing:
- **Keys hash as JSON round-trips them** (`keys.ts`). An `undefined` member hashes as absent, a `Date` as its ISO string, and non-finite numbers and array holes as `null`. This reversed three tests that pinned the old identities (R-Q3.8 among them). SPEC §5.4.
- **A stale epoch** decides whether a fetch's success clears an invalidation (`entry.ts`, `infinite.ts`). Hydration follows the same rule. SPEC §5.7.
- **Live hydration skips a row older than the entry**, and a future timestamp reads as now. SPEC §15.
- **`firstValue()` resolves at once when data is present.** `status` still goes `'pending'` during any fetch, which SPEC implies through `cancel()` and `reset()`; the guides said otherwise and were corrected.
- **`MutationEvent` gained `'queued'`** (a waiting `serial` run) **and `reason` on `'cancel'`** (`'superseded'`, `'reset'`, `'dispose'`). The queue drops an entry on a deliberate cancel and keeps it on dispose. SPEC §13.1, §13.3.
- **`RetryPolicy` accepts `false`**, as SPEC §5.2 always said.
- **Async validators run only after every sync one passes.** A validator counts as async when declared `async`, or once it has returned a promise. SPEC §8.1.
- **One error list per routing form** (`RoutedErrors`). SPEC §8.3.
- **Child factories run untracked, and a child built under a suspended parent starts suspended.** SPEC §3.4, §4.1.
- **Cross-tab's default factory opens a channel only with a DOM or a `WorkerGlobalScope`**, and never on Deno or Bun. SPEC §13.2.
- **Entity handles follow their id** across `remove` and eviction, and a subscribed id is not evicted. SPEC §18.1.
- **`useQuery`'s render detection is a commit counter**, and the two keep-alive helpers share one suspend-reason record. SPEC §16.1.

**Numbers.** Tests went from 2,238 to 2,389 in 184 files. The public API changed in two places (`RetryPolicy`, `MutationEvent`). Nine size budgets were re-set to about 5% over the new sizes; `decisions/esm-only-build.md` records them.

**BACKLOG** gained three follow-ups: a superseded run that still sends once behind a slow storage write, `indexedDbAdapter`'s channel on a server, and `Form.reset()` calling `initial()` unguarded.

## [2026-09-25 16:30] ingest | the correctness pass, second round: 39 more findings fixed

**Review.** Four reviewers checked the first round's fix commits and the packages no one had read: vue, svelte, router, devtools, eslint-plugin, codemod and the docs. They reported 39 findings. About half were gaps or regressions in the first round's own fixes, both high ones among them:
- `HydrationBoundary` disposed its root in a layout-effect cleanup, and React runs those when a `<Suspense>` above hides shown content. A later suspension killed the live app root (`pitfalls/render-phase-root-leak.md`, rule 5).
- The stale-epoch fix left the join paths open: a subscriber, `resume()` or `prefetch` that joined an older in-flight fetch never refetched after the invalidation.

**Fixes.** Six agents, one set of files each, plus the `HydrationBoundary` fixes by hand; every finding got a failing test first. The decisions worth knowing:
- **The entry runs a catch-up fetch** when data lands under a surviving stale mark and someone holds the entry, which covers every join path, hydration and page requests at once (`entry.ts`, `infinite.ts`). SPEC §5.7.
- **Live hydration compares against `serverUpdatedAt`**, which only a fetch, a hydrated row or a canonical write sets; buffered rows keep the newest; `dehydrate()` ships every entry that holds data. SPEC §15.
- **Parked entries resume on interval, focus and reconnect once online**, instead of waiting only for a `window` `'online'` event. SPEC §5.9.
- **Core sends `mutation:cancel`** with the run's `reason`, and devtools pairs settles with starts by `causeId`. SPEC §14.1.
- **The mutation queue gives a queued `serial` run its own entry**, and a kept `dedupeBy` entry holds the newest write. SPEC §13.3.
- **The first `initial()` value seats per leaf**: untouched fields fill in, an edited field keeps its value and takes the loaded baseline. SPEC §8.4.
- **A `null` for a nested form or field array leaves it alone**, as `undefined` does. SPEC §8.
- **A `retryDelay` of `NaN` retries at once** instead of sleeping forever (`utils.ts`, `abortableSleep`).
- **Svelte's `fieldStore` binds by member**, and the docs say to bind a form's leaf fields rather than `$form.member`. Vue refs skip subscribing during SSR, and `useField().value` reads through inside a `batch`.
- **Devtools** survives any key shape or throwing `ctx.debug` computed, keeps history in the launcher, and leaves a non-`key=value` URL hash alone.

**Numbers.** Tests went from 2,389 to 2,533 in 187 files. API reports changed for core (`mutation:cancel`), devtools (`store` prop, `cancel` entry kind) and vue (`useField().value` is a `Ref<T>`). Seven size budgets were re-set; `decisions/esm-only-build.md` records them.

**BACKLOG.** The three first-round follow-ups are fixed and removed. Two ideas were added: `gcTime`/`maxIdleTime` of `NaN` never expire, and an optimistic write makes a stale entry look fresh.

## [2026-09-25 18:10] ingest | three review notes: optimistic staleness, the boundary retry loop, release closure

**Optimistic writes and staleness** (`entry.ts`, `infinite.ts`). `isStaleNow()` read `lastUpdatedAt`, which an optimistic `setData` moves, so a new subscriber skipped the refetch of stale server data after a write, and after a rollback it kept old server data as fresh. Staleness now reads the server clock (`serverUpdatedAt`), and the `isStale` signal reads the same one. A fetch wanted while an optimistic write is live, by a subscriber, `resume()`, focus, reconnect or `prefetch`, is held back so its response cannot overwrite the guess, and it runs once the write settles, one microtask later, so a sync `onSuccess` invalidation takes over. The settle fetches only to pay back a held fetch: with the default `staleTime: 0` a held entry is always stale, and fetching on every settle would refetch after every optimistic mutation. SPEC §5.3, §5.9, §6.4. BACKLOG keeps one gap: an interval tick does not consult staleness, so it can still land over a live guess.

**`HydrationBoundary` below an outer `<Suspense>`** (`context.ts`, `findReusable`). A parent that re-creates the boundary on every retry made each retry build a new root, refetch and suspend again (22 roots in 200 ms). A retry now also reuses an unclaimed root built from the same `def`, the same `hydrate` object and `deps` with the same members. Two boundaries that share a `def` can both find one root; the commit that fails to claim it rebuilds, as before. When the options changed between attempts, a development build warns once. `pitfalls/render-phase-root-leak.md` has the rule.

**Release closure.** A dry run of `changeset version` in a throwaway worktree takes all 14 packages to 1.0.0, and rewrites 13 internal peer ranges to a bare floor. `scripts/pin-peer-ranges.mjs` puts the upper bound back; `pnpm version-packages` runs both, `version.yml` calls it, and CI and the publish workflow run `pnpm check:peer-ranges`. The repo now lets Actions open pull requests, and an `NPM_TOKEN` secret exists, so both BACKLOG release blockers are gone. mutation-queue's `>=0.9.0` floor on core is deliberate: it needs core APIs a 0.9.0 was to ship, and `changeset version` rewrites it at 1.0.

## [2026-09-25 19:30] ingest | every dependency on its latest version

**What moved.** TypeScript 6.0 → 7.0, vitest 4 → 5 (with coverage-v8), jsdom 29 → 30, tsdown 0.22 → 0.23 (rolldown-plugin-dts 0.28), biome 2.4 → 2.5, changesets 2 → 3, pnpm 10 → 12, `@types/node` 25 → 26, Vite 8.0 → 8.3, React 19.2 → 19.3, zod 4.4 → 4.6, lucide-react 1.16 → 1.48, and the GitHub Actions: checkout v7, setup-node v7, pnpm/action-setup v6.1.0, changesets/action v2.1.2, upload-pages-artifact v5, deploy-pages v5. `decisions/toolchain.md` records why each forced change is the way it is.

**The decisions worth knowing:**
- **Two TypeScripts.** `tsc` is 7.0 (`@typescript/native`), and `typescript` is the 6.0 API (`@typescript/typescript6`), because five tools call an API 7.0 does not ship.
- **Node 22 to build.** The toolchain's floor is jsdom's `^22.22.2 || ^24.15.0 || >=26`. The dist smoke on Node 20.19 now builds on 22 and runs `verify-dist.mjs` alone on the matrix Node.
- **Changesets 3 plus a guard.** It releases a package whose peer range a release leaves behind as a patch; `check:peer-bumps` fails until a changeset names it as major (`decisions/peer-bump-guard.md`). A dry run on two worktrees showed core 2.0.0 taking react to 2.0.0 under changesets 2.31 and to 1.0.1 under 3.0.3.
- **pnpm 12's release-age window** held vitest at 5.0.1 and size-limit at 14.0.0; BACKLOG takes them tomorrow.

**What broke and how it was fixed:**
- rolldown-plugin-dts 0.28.2's inline exports leaked entities' private `BRAND` and `PHANTOM` symbols into its public types. `api:check` caught it, and an entities build plugin appends `export {}` (`pitfalls/dts-export-context.md`). Four other API reports changed only in formatting.
- vitest 5 removed the `bench` export; both bench files now run `bench` from the test context.
- biome 2.5 added `noUnsafeOptionalChaining`, `noProto` and `noSvgWithoutTitle` to its recommended rules, and its formatter wraps `test.each` differently.
- rolldown 1.2 warned on devtools' CSS transform, which now returns a `magic-string` sourcemap.
- The VitePress build lost `vue/server-renderer` under the pnpm 12 install, so the root declares `vue`.
- Vite 8.3 warned on config files its future native loader cannot read, so the root package is `"type": "module"` and the example configs import `aliases.ts` with its extension.

**Verified locally** on Node 26.8.1 and pnpm 12.6.0: build, typecheck, lint, `check:peer-ranges`, `check:peer-bumps`, `check:doc-snippets`, `test:coverage` (2,558 tests in 188 files, every gate met), the examples' tests and builds, publint, attw, `smoke:dist`, `check:public-types`, `api:check`, size, `docs:build`, `pnpm bench` and a Stryker dry run. The workflows themselves have not run yet; the publish path's `~/.npmrc` auth was checked with a fake token against `pnpm whoami`.

## [2026-09-25 20:11] ingest | core outside the query engine: fifteen review findings

A review pass reported fifteen bugs in controllers, forms, selection and the devtools bus, each with a failing repro. Each is fixed here with a regression test that fails on the old code. The pages that changed are `modules/controller.md`, `entities/controller-instance.md`, `flows/construction-rollback.md`, `modules/forms.md`, `modules/errors.md`, `modules/devtools.md`, `entities/scope.md`, `entities/ctx.md`, `pitfalls/fieldarray-factory-uses-initial.md` and `decisions/forms-are-read-signals.md`. Two pages are new: `modules/selection.md`, and `pitfalls/batched-effect-not-run-yet.md` for the C2 footgun.

**Controllers** (`dynamic-children.test.ts`, `controller-regressions.test.ts`):
- C1. One collection item whose `keyOf`, `propsOf` or `factory` throws is skipped with `kind: 'construction'`, and the reconcile lands. A kept key whose factory throws keeps its child. `coverage-core-controller.test.ts` pinned the old `'effect'` kind for `keyOf` and now expects `'construction'`.
- C7. A disposed `lazyChild` handle reads `'idle'` with no `api`, mid-load too, and a loader that throws or returns no promise sets `'error'`, reports, and rejects. A collection whose owner disposed lists nothing.
- C8. The rollback marks the controller disposed before its teardown, as `dispose()` does.
- C9. `ctx.inject` and `root.inject` answer after dispose; `dispose()` keeps the scope maps.
- C10. `root.suspend({ maxIdleTime })` after dispose arms nothing.
- C13. A collection key rebuilt for a new type keeps `suspendItem`.
- C15b. `construct` marks a factory throw, and `dispatchError` reports a marked error as `'construction'` wherever it is caught.

**Forms** (`form-regressions.test.ts`):
- C2. `revalidate()` waits a microtask when its trigger bump ran no pass, which is the case inside `batch()` or an effect.
- C3. `debouncedValidator` rejects on a sync throw or a no-promise return, and the rejection is reported as a validator bug.
- C4. `dirtyFields` lists a structurally dirty array by its own path and none of its items.
- C6. A form reads `initial: null` as none, the reactive seat catches a throw, and a field array builds new rows before it drops the old ones.
- C12. `setErrors` with a path that names a nested form or array, or `''`, pins the messages on that node's `topLevelErrors` until its value changes. `coverage-core-form.test.ts` pinned `''` and `tags` as ignored and now expects them to land.
- C14. A no-op `reset()` re-runs the sync validators. The async ones stay out: `form-regressions.test.ts` pins a no-op reset dropping an async result, and a re-run would send a request for a value the user did not change.
- C15a. `field.touched`, `isDirty`, `isValidating`, `form.isSubmitting`, `submitCount`, `submitError` and `array.items` are `readOnly` views.

**Elsewhere.** C5: a shift-click with a `Map` ranges by index value (`selection.test.ts`). The meta-click that deselects the anchor keeps it, and `deselect()` clears it, now documented in `modules/selection.md` and SPEC §16.5. C11: `DevtoolsEmitter` calls handlers untracked (`devtools.test.ts`).

**Spec.** §4, §4.3, §8.1, §8.2, §8.3, §8.5, §8.6, §11.1, §12.1, §14, §16.5 and §20.7 describe the new behaviour. No public signature changed; TSDoc on `Collection`, `LazyChild`, `Ctx.collection`, `Ctx.lazyChild`, `Root.inject`, `Root.suspend`, `Form.dirtyFields` and `Form.setErrors` did. Wiki citations into the edited files were shifted by the diff's line map.

## [2026-09-25 20:17] ingest | persist and the mutation queue: seven review findings

A review of `@kontsedal/olas-persist` and `@kontsedal/olas-mutation-queue` found seven bugs, each with a repro. Each fix has a regression test that failed on the old code.

**Persist.** P1: `persistQueryCachePlugin` wrote the tab's whole map over the shared key, so a flush deleted what other tabs wrote since startup, and put an older restored copy over a peer's fetch. Every flush now reads storage and merges, newer `lastUpdatedAt` wins, and a gc leaves a timed tombstone (four tests under "two tabs on one storage", `query-cache.test.ts`; new pitfall `shared-storage-whole-writes.md`). P4: a synchronous `storage.get` that throws escaped `createPersisted`; it now reports `'load'`, and `localStorageAdapter` treats a `localStorage` getter that throws as missing (`persist.test.ts`). P5: `set(undefined)` stored `{"$olas":1,"v":N}` or failed as `'serialize'`. It is now the marked envelope with no `d`, and a peer's delete puts back the pre-load value, so a peer reads what a reload reads (`undefined-value.test.ts`; new pitfall `json-stringify-undefined.md`). P8: `indexedDbAdapter` never reopened after the browser closed its connection; it now drops the connection on `close` and retries once on `InvalidStateError` (`coverage-indexeddb.test.ts`; new pitfall `browser-storage-handles-fail.md`).

**Mutation queue.** P2: a retryable replay failure let later entries of its id overtake it; a kept entry now ends its group's pass (`replay-order.test.ts`). P3: a replay's success, and a live owner's, deleted an entry a `dedupeBy` collapse had rewritten; the replay compares the stored `seq`, and the live success hands the entry to a newer rider (`deliberate-cancel.test.ts`; new pitfall `success-drops-a-rewritten-entry.md`). P9: a replay pass sent an entry another tab's live run still had out; live runs now mark their entry with a Web Lock, or a `localStorage` lease with a heartbeat (`coverage-replay-lock.test.ts`). Writing that lease found R5: a lease dated in the future held the replay lock forever (`decisions/trust-model.md`).

**Decisions recorded.** A peer's delete maps to the pre-load value, not `undefined` (`modules/persist.md`). Web Locks per entry over an owner field in the stored entry, which would need a format change and a rewrite on settle (`modules/mutation-queue.md`). A missing definition does not stop its group, since every entry of the group shares the id. Four older tests changed with the behaviour, each named in the module pages. `modules/mutation-queue.md` goes to `medium`, since its new sections were written in the session that wrote the code.

**Left open.** A collapse during a replay of its entry sends beside the replay (`BACKLOG.md`). SPEC §13.3 and §13.4 and both package READMEs describe the new behaviour, including the query cache across tabs. No public signature changed.

## [2026-09-25 20:25] ingest | the framework adapters and the devtools panel: nine review findings

A review of the React, Vue and Svelte adapters and the devtools panel found nine bugs, each with a repro. Each fix has a regression test that failed on the old code.

**Streaming SSR** (`streaming-hydration.test.tsx`, new, over React 19.3's browser and Node server builds; `streaming-security.test.tsx`). A1: `createStreamingTransform` wrote a batch at any chunk end in text, so a shell larger than a chunk put it inside a list item, and a large `<Suspense>` segment put it inside `<div hidden id="S:0">`, which React's reveal moves into the boundary. `HtmlBoundary` now reads bytes and keeps a stack of open elements and boundary comments. A batch goes directly inside `<body>` for a document, or at the top level of a fragment, outside every boundary, right after a tag or a comment, at the first such point in a chunk. The close-time drain skips a stream that ended inside markup. A2: `HydrationBoundary` folds the batches already on the page into the root's `hydrate` as it builds it, so the hydrating render reads them and no fetch starts; a reused uncommitted root catches up in render, and a `StreamCursor` per root keeps a re-run effect from applying a batch twice. A5: a root built for a new `def` gets no cursor and takes no streamed batch. `pitfalls/stream-chunks-split-tags.md` claimed the mid-text placement was handled; it now describes the real rule, and corrects the view size to 2,048 bytes in the browser build and 4,096 in the Node and edge builds.

**`HydrationBoundary` and `<Activity>`** (`hydration-boundary.test.tsx`). A4: an `<Activity>` hide ran the passive cleanup that disposed the root. React gives no signal that tells a hide from an unmount, so the cleanup now suspends the root and disposes it after `RELEASE_GRACE_MS`, a minute, unless the effect runs again. StrictMode keeps one root, suspended and resumed. Test (a) pinned an immediate dispose and now advances the grace period; (g) does the same. New pitfall `effect-cleanup-not-unmount.md`; `render-phase-root-leak.md` rule 5 and its citations updated.

**Suspense** (`suspense.test.tsx`). A3: `suspendUntilData` suspended on `data === undefined`, which looped on a load that settled on `undefined`. It now suspends only until a success, data or a `lastUpdatedAt`. New pitfall `suspend-on-undefined-data.md`. Vue and Svelte have no Suspense hook.

**Vue** (`vue.test.ts`). A7: `useRoot()` outside `setup()` threw a raw `TypeError`; it checks `hasInjectionContext()` first. A8: `useValue`'s getter ignored `isEqual`; it now returns the value it last returned while `isEqual` holds, as React does. The adapter-parity suite gained that scenario, with a `lacks` list on `Harness`: Svelte skips it, having no `isEqual`.

**Svelte** (`svelte.test.ts`, fixture `FieldObject.svelte`). A6: a nested bind on an object-valued `fieldStore` edited the field's value and `initial` in place and set the same object back. Each subscriber now gets a shallow copy of a plain-object or array value. A raw `Field` bound the same way needs a core change, recorded in `BACKLOG.md` and SPEC §16.3; Vue's `v-model` on a member has the same shape and is documented in §16.2. New pitfall `bind-mutates-in-place.md`.

**Devtools** (`store-reattach.test.tsx`, new). A9: StrictMode's re-attach logged the bus's replay again. `attach` marks the replay, and a replayed construct or suspend that repeats the tree updates it without a timeline row. A cell's new `constructed` flag tells a controller from a bare ancestor the replay created first.

**Spec.** §16.1, §16.2, §16.3, §16.4 and §22 describe the new behaviour. `docs/guide/ssr.md`, `RECIPES.md`, `API.md` and the three adapter READMEs too. No public signature changed; `installStreamingIntake` keeps its signature, and the cursor functions stay internal to `streaming.ts`. Three `[idea]` entries went to `BACKLOG.md`: the raw-`Field` core change, a Vue write-through for `v-model` on a member, and a configurable release grace.

**Core's new `'commit'` write source.** The streaming hydrator captures it beside `'fetch'`, `'write'` and `'replace'`: it is the data the server rendered once no optimistic guess is left, and skipping it would ship the value from before the mutation (`coverage-streaming.test.tsx`). The devtools panel shows every source as plain text, so a commit row reads `source: commit` with no new mapping (`coverage-panel-timeline.test.tsx`). The satellites typecheck against core's built `dist`, which lacks `'commit'` until the next build, so `pnpm --filter @kontsedal/olas-react typecheck` and the devtools one report TS2367 and TS2322 there; against core's source both are clean.

**Size.** The budgets in `.size-limit.json` went to 5.2 KB for react and 0.97 KB for vue and svelte, from esbuild-and-brotli estimates, since this pass ran no build (`decisions/esm-only-build.md`). To keep react small, `HtmlBoundary` became the closure `htmlBoundary()` and dropped its void-element list: React writes `<br/>`, and an element left open closes with its parent.

## [2026-09-25 20:30] ingest | the query engine: twelve review findings

A review of the query engine found twelve bugs, each with a repro. Each fix has a regression test that failed on the old code: every fix was switched off once and its tests failed.

**Optimistic layers** (`optimistic-layers.test.ts`, new). Q1: a canonical `write` set each live baseline to the value on screen, so a rollback kept the guess; the write now re-runs its patch on each baseline, and a `replace` value still becomes each one. Q2: `finalize()` left the baselines below it alone, so an older layer's rollback lost a newer commit; the committed layer's updater now runs on each of them. The fold is skipped when a fetch or a hydrated row landed while the layer was live, because re-running a toggle over a read that holds it would flip it back. An updater that throws on a baseline makes the entry mark itself stale and refetch once the layers settle. New pitfall `visible-data-is-not-a-baseline.md`. The property models in `tests/property/` now drive whole-value and patch writes and model both rules; each rule was broken three ways to confirm the models fail.

**The `'commit'` source** (`plugin-host.test.ts`, "onWrite — commit"). Q6: `finalize()` reported nothing to plugins. `WriteSource` gains `'commit'`, reported once no layer on the entry is live, with the data on screen and the server clock as `updatedAt`. A commit made under another layer is reported by the settle that clears the last one, a rollback included, in place of its `'rollback'`. The rule keeps a canonical-only plugin from taking a pending guess and from missing the committed value.

**Parks** (`query-focus-online.test.ts`). Q3: `cancel()` now drops a fetch parked for the network, its callers rejecting with an `AbortError`. Q5: a fetch made online adopts the park, so a parked `invalidate()` settles and a late `online` event fetches nothing. An infinite refetch runs the parked page requests after it, and an online page request serves the parked ones of its direction.

**Infinite paging** (`infinite-edges.test.ts`). Q4: a refetch starts from `pageParams[0]`, where it started at `initialPageParam`; SPEC §5.11 said both, and now says the first. Pages written into an entry with no params pad with `initialPageParam`, not `undefined`. Q8: paging before the first page joins the first load.

**SSR** (`ssr.test.ts`). Q9: a buffered row with `undefined` data gives `status: 'success'`, as a live one does. Q10: `dehydrate()` ships `Entry.serverState()`, the data beneath any live guess, stamped with `serverUpdatedAt`, or `0` when the server never answered.

**Subscriptions** (`use-edges.test.ts`, `select.test.ts`, `cache.test.ts`). Q12: `firstValue()` never waits on nothing. On an idle entry with nothing coming it starts a fetch, and a cancel while it waits makes the entry fetch again one microtask later, unless data arrived. It never rejects for a cancel, so a Suspense boundary loads again. It stays compatible with the React hook's new rule, which suspends until a success, data or a `lastUpdatedAt`. Q11: `firstValue()` and `refetch()` skip `select` for `undefined`. Q7: a local cache compares keys by `stableHash`, and an equal key does nothing.

**Spec, docs and wiki.** SPEC §5.2, §5.3, §5.5, §5.9, §5.11, §6.4, §13.1, §15 and §21.9 describe the new behaviour; `PLUGINS.md`, `API.md`, `docs/guide/queries.md` and the glossary too. `entities/entry.md` was rewritten for the new sections; `modules/query.md`, `decisions/canonical-vs-optimistic-writes.md`, `decisions/engine-assurance.md`, `decisions/infinite-query-parity.md`, `decisions/plugin-host-v2.md`, `flows/ssr.md`, `flows/plugin-lifecycle.md` and `entities/query-client.md` were updated. Wiki citations into the engine files were shifted by the diff's line map.

**Public surface.** `WriteSource` gains `'commit'`, the only signature change. TSDoc on `AsyncState`, `Snapshot`, `Query.write` and `Query.cancel` changed. `BACKLOG.md` gained one `[idea]`: a `'write'` event under a live optimistic write carries the guess, which a canonical-only plugin stores.

## [2026-09-25 21:05] ingest | a set of the held object is a change; form baselines are copies

A follow-up from the adapters agent. Svelte writes `bind:value={$person.first}` on a raw `Field` as an in-place assignment on the field's value object, then `set` with that same object. The field heard no change, and its `initial` was that object, so `reset()` returned the edit. `FieldImpl` now boxes its value (`Held<T>`), and `set` of the held object writes a new box: subscribers hear it, validators run, `isDirty` is recomputed. A primitive equal by `Object.is` is still no change, and `setAsInitial` and `reset` leave the same object alone, so a structurally shared refetch through a reactive `initial()` re-validates nothing. The first attempt wrote a stand-in and then the value inside the `batch`. `@preact/signals-core` reconciles such a pair as no change, which `modules/signals.md` now records.

Every baseline is a `copyPlainData` copy: plain objects and arrays at every depth, anything else by reference, which is the part `isStructurallyEqual` compares by content. The field copies in its constructor, `setAsInitial` and `rebaseInitial`, and `reset()` writes a fresh copy unless the value already matches. A `Form` keeps a fixed `initial` as `staticInitial`, and a `FieldArray` its `initialItems`; both reset from a fresh copy. A thunk `initial` is not copied, so a nested bind on a field seated from query data still edits the cache, which SPEC §16.3 says.

Pinned by `form-regressions.test.ts`, "an object value edited in place and set back, as a Svelte nested bind does" and "copyPlainData, the baseline copy". Pages: `modules/forms.md`, `modules/signals.md`, `modules/svelte.md`, `modules/vue.md`, `pitfalls/bind-mutates-in-place.md`. SPEC §8.1, §16.2 and §16.3, the svelte and vue READMEs, and the BACKLOG entry (removed) follow.

## [2026-09-25 20:57] ingest | cross-tab, entities and the 'commit' source: four findings and the guess-carrying write event

The second phase of the persist and queue review. Each fix has a regression test that failed on the old code.

**Core, small.** `WriteEvent.server` is the entry's server truth, what `dehydrate()` ships, read from `serverState()` at every emission site (`flows/plugin-lifecycle.md`). `host.queries.setData` is a plugin-owned optimistic write that returns its `Snapshot`. Both are pinned in `plugin-host.test.ts`. The core agent's BACKLOG idea, "a canonical write event under a live optimistic write carries the guess", is fixed by `server` and removed. `devtools.ts` lists `'commit'`.

**P6, entities.** `update` wrote a whole value built from the store, which shows a guess, so core set every baseline to it and a failed like stayed everywhere. The backprop now patches each entry's own copy, and core re-runs the patch per baseline. The store keeps walking every source, so it shows a live guess and holds settled data once the layers settle (`optimistic-backprop.test.ts`). **P11:** the rebuild keeps prototypes through `copyRecord`.

**P7 and P10, cross-tab.** A peer's guess arrived as a canonical write, and a peer's `replace` as a patch. Messages now carry `source`, plus `server` for a write made under a guess. The receiver shows a guess through `host.queries.setData`, settles it on the peer's rollback or commit, and drops it after 30 seconds of silence. It applies a replace as a replace (`optimistic-relay.test.ts`, and `packages/integration/tests/optimistic-cross-tab.test.ts` with the persister and entities).

**'commit' consumers.** The persister stores `server` for every source, so a guess is never stored and a commit is. A commit stamped `0` is skipped, and the `<=` tie rule is what lets a commit replace its fetch's row. Cross-tab relays commits with `optimistic` on and off, and entities walks them.

**Found, left to core.** A commit above a rolled-back layer keeps that layer's guess on screen and reports it as `'commit'` (`BACKLOG.md`). The fix is in `Entry.finalize`, outside this phase's edit area.

**Housekeeping.** Every `client.ts` citation in the wiki was re-pinned through a line diff of this phase's edits. `modules/cross-tab.md` goes to `medium` for its new sections. SPEC §13.1, §13.2, §13.4 and §18.1, PLUGINS.md and the cross-tab, entities and persist READMEs describe the behaviour. Public surface: core's `QueryHost.setData` and `WriteEvent.server`, and cross-tab's `SetDataMessage.source`, `SetDataMessage.server` and new `RelayedSource` type (`api:update` needed).

## [2026-09-25 21:15] ingest | an out-of-order rollback replays the layers above it

**The bug.** The phase-2 agent found it while wiring the plugins onto the query-engine fixes, and filed it in BACKLOG. A rollback of a layer below the top threaded its baseline onto the layer above and left the rest. The layers above, and the data on screen, still held its delta. Layer A sets `a`, layer B sets `b`, A fails: the screen kept `{ a: true, b: true }`, and B's commit reported that as `'commit'`, which the persister stored and cross-tab relayed.

**The fix** (`entry.ts`, `infinite.ts`, `replayFrom`). The rollback now replays the layers above the removed one over the baseline it restored: each baseline is the one below with that layer's updater applied, and the screen takes the top's result, structurally shared so an unchanged replay reports no write. A layer a fetch or hydrated row replaced passes through, as in the commit fold. A plain value (a zero-parameter updater, such as cross-tab's mirrored `() => data`) and an updater that throws cannot be replayed exactly; the entry then reconciles, stale plus a refetch once the last layer settles. The replay runs at the rollback itself rather than at the next settle, as the coordinator's note put it: the deferral in SPEC §6.4 existed only because nothing could replay, and replaying at once also gives the `'rollback'` event and `WriteEvent.server` the corrected value. `InfiniteEntry` records now keep the `pageParams` their write was given, so the replay and the commit fold align params as the write did.

**Tests.** `optimistic-layers.test.ts`, "an out-of-order rollback leaves no guess behind" (seven tests, the reproduction first). R-Q3.1 in `regressions.test.ts` pinned the failed delta staying on screen and now expects the replayed value. Both property models replay; the replay was switched off, and then made to replay layers a read replaced, and both models failed each time.

**Spec, BACKLOG and wiki.** SPEC §6.4's non-top bullet and the "not full rebasing" paragraph now describe the replay. BACKLOG loses the phase-2 entry and the `[dropped]` "Full updater-replay rebasing" item, which this lands: the updater closures it said rebasing would keep alive are kept since the commit fold. `entities/entry.md`, `pitfalls/visible-data-is-not-a-baseline.md` (a third case), `decisions/engine-assurance.md`, `modules/query.md`, `entities/query-client.md` and the glossary were updated; citations into `entry.ts` and `infinite.ts` were re-pointed. No public signature changed.

## [2026-09-25 22:40] ingest | the docs site gets its own theme and a shorter path in

The site was stock VitePress: an indigo accent from the default kit, an empty right half in the hero and six identical feature cards. The ask was "simple, easy to understand and pretty".

**Theme** (`docs/.vitepress/theme/`). The house palette from `tokens.css`, sea teal and cool neutrals, in both themes, and the favicon moved off indigo. Atkinson Hyperlegible Next and Mono, self-hosted through two new root devDependencies. A home hero of its own, `HomeHero.vue`, with `TwoTrees.vue`, the two-trees diagram, as its figure; the same component replaces the ASCII tree in Concepts. Tables lost their stripes, code blocks took an edge, and the paragraph under a page title became a lead.

**Content.** The home page is three sections: one feature in three files (controller, view, test), what the core does, and the package list. A new page, `guide/what-is-olas.md`, says what the library is, the problem, the idea, one controller and when it fits. Getting started puts install and render behind `<FrameworkPicker />`, and each framework's tab now carries its own `Register` augmentation, so root.ts is framework-free. The sidebar is regrouped for a new reader, and the nav has four items.

**Reference.** `docs-sync.mjs` promotes each api-documenter title to an H1, renames the "Home" crumb, and writes the index from each `package.json` `description` instead of api-documenter's empty table.

**Checked.** `check:doc-snippets` on the four changed pages (22 snippets, 0 errors), `prose:lint` clean on the new and edited pages, biome on the theme and the sync script, and `vitepress build` with its dead-link check. The pages were screenshotted at 1440px and 390px in both themes; the picker was driven by keyboard and click, and its choice survived a page change. `decisions/docs-site.md` has the theme section, the reference section and two pitfalls: a bare `display: grid` widened the phone layout, and headless Chrome's minimum window width fakes an overflow. `decisions/ui-rules.md` lists the docs site as a surface.

Not deployed. The site still goes live only by pushing the built output to `gh-pages` (BACKLOG, Release).

## [2026-09-25 20:10] external | the 1.0 release published once before its version PR

**What happened.** PR #3 (`release/1.0`) merged at 19:46 UTC, and the Version workflow opened PR #4. The Publish workflow ran at 19:47, before #4 merged, so `main` still carried the pre-release versions. Ten packages were already on npm at 0.8.0 and were skipped. The four never published before, codemod, eslint-plugin, svelte and vue, sat at `0.0.0` and went to npm at that version, with `@0.0.0` git tags. PR #4 then merged, and a second Publish run released 1.0.0 for all fourteen; `latest` points at 1.0.0 everywhere. The push that merged #4 failed the Version workflow: `changeset version` exits 1 with "No unreleased changesets found", and `changesets/action/version` runs it regardless.

**Fixes.** `publish.yml` now refuses to run while a changeset is on `main`, since `changeset version` deletes the ones it applies; `main` held 110 at the first run. `version.yml` counts pending changesets and skips its remaining steps at zero. CLAUDE.md's Releasing section says both.

**Left open.** The four `0.0.0` versions and their tags are still published. The working tree's uncommitted fixes, with 25 patch and minor changesets, were not on `main`, so 1.0.0 shipped without them; they release as core 1.1.0 and 1.0.x patches once committed.
