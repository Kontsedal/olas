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

