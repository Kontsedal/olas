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
- Phase 10 (`@olas/react` + scopes) lands → add `modules/react.md`, `entities/scope.md`, `flows/use-root.md`.
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

## [2026-05-18 19:30] ingest | Phase 10 — scopes + `@olas/react`

Spec §10.3 + §16 + §20.10 land. Two pieces in one phase, per §22.

What shipped:

- **Scopes in `@olas/core`** — new `packages/core/src/scope.ts` (`defineScope`, `Scope<T>`). `Ctx` gains `provide<T>(scope, value)` and `inject<T>(scope): T`. `ControllerInstance` carries a lazy `scopes: Map<symbol, unknown> | null` and `inject` walks the parent chain. Throws synchronously during construction when no provider + no default. 11 new tests in `packages/core/tests/scope.test.ts` cover: distinct identity, hasDefault flag, shadow semantics, missing-provider error, default fallback, reactive scope value via embedded signal.
- **`@olas/react`** — was empty shell; now ~230 LOC across `context.ts`, `hooks.ts`, `keep-alive.ts`. Built on `useSyncExternalStore`. Public surface matches §20.10 exactly: `OlasProvider`, `useRoot`, `useController` (alias), `use(signal)`, `useQuery(subscription)`, `useField(field)`, `<KeepAlive>`, `useSuspendOnHidden`. `useQuery`/`useField` batch N subscribes into one render trigger via a per-hook version counter. 7 new tests in `packages/react/tests/adapter.test.tsx` cover the four spec-required cases (signal re-render, query invalidation, StrictMode safety, field/`<input>` round-trip) plus provider edge cases.
- **Testing helpers** — `fakeField<T>` and `fakeAsyncState<T>` added to `@olas/core/testing`, per §20.10.

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

## [2026-05-18 21:10] ingest | Phase 13 — `@olas/devtools` (in-app variant)

Spec §13 ships as an in-app `<DevtoolsPanel>` rather than a browser extension. The same `root.__debug` contract works for either; the extension is a future thin wrapper around the wire format.

What shipped:

- **New `@olas/devtools` package.** Drop-in React panel + lower-level `DevtoolsStore`. Four tabs: Tree (live controller tree from construct/suspend/resume/dispose events), Cache (fetch lifecycle + invalidate/gc), Mutations (run/success/error/rollback), Fields (validation outcomes — runtime not yet emitting these but the rendering is wired). Inline-scoped CSS so it's truly drop-in. Bounded logs (default 100/each); a Clear button empties them but preserves the live tree.
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
- Signal dependency graph view (spec §13 mentioned; needs additional plumbing inside `@olas/core/signals`).

## [2026-05-18 22:10] ingest | three new example apps for breadth + testability

Goal: stretch the public API across three intentionally different runnable
apps so the eloquence + testability claim is concrete. Each app has its own
`package.json`, Vite dev/build, vitest config, in-memory api, and unit tests.

What shipped:

- **`examples/_shared/aliases.ts`** — single source of Vite + Vitest source aliases for `@olas/*` packages so apps run without a pre-built `dist/`.
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

