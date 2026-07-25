# handoff.md — REMEDIATION.md execution, session handoff

**Transient file** (like `REMEDIATION.md`). Delete both when the remediation lands.
Written 2026-07-25; updated after completing Phase 6 (all satellite packages, T6.1–T6.7).

---

## TL;DR

- Working on branch **`remediation`** (off `main`). All work is committed.
- **Phases 0–6 DONE** — 40 tasks (T0.1–T0.4, T1.1–T1.2, T2.1–T2.8, T3.1–T3.9, T4.1–T4.7,
  T5.1–T5.3, T6.1–T6.7). Two `[?]` items along the way: T2.8 pathKey (could-not-reproduce),
  T4.7 disabled+suspense (could-not-implement-cleanly → BACKLOG).
- Pipeline is **green**: `pnpm test` → 751/751, typecheck clean, biome lint clean,
  `pnpm wiki:lint` 0 errors.
- **Next task: T7.1** (Phase 7 — delivery/docs/release). ⚠️ **T7.1 ends in `npm publish` — an
  outward-facing action that needs the user's explicit go-ahead. Do the CHANGELOG/changeset/CI
  prep, then STOP and ask before publishing.** See "Next up" below; `REMEDIATION.md` is the
  source of truth.

## Read this first (resume order)

1. `REMEDIATION.md` → "How to work this plan" (top) + find the first unchecked `[ ]` task.
2. `CLAUDE.md` → SPEC/wiki/BACKLOG conventions (already being followed).
3. `.wiki/index.md` → then the specific page for the module you're touching.
4. `.wiki/log.md` (bottom) → the per-phase ingest entries record what changed.

## Per-task workflow (what every commit has looked like)

1. **Test-first.** Add a regression test to `packages/core/tests/regressions.test.ts`
   (convention: `describe('regression: … (R-XN)')`, e.g. `R-Q1.1`, `R-L2.6`). Run it,
   **watch it fail** against unmodified source (`pnpm vitest run <file> -t "R-XN"`).
   Helpers already in that file: `flush`, `deferred`, `emptyDeps`.
2. **Fix** the source.
3. **Watch it pass** + run the neighbouring suites you might have touched.
4. **Docs in the SAME commit**: the SPEC §, the `.wiki/` page(s), and `API.md` the task
   names. Bump the wiki page's `last_verified` to today **only after re-reading** the
   covered code.
5. **Flip the `REMEDIATION.md` checkbox** (`[ ]`→`[x]`) in the same commit.
6. Commit: `type(scope): summary` + body, ending with `REMEDIATION.md TX.Y.` and:
   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```

**Per phase (gate):** `pnpm build && pnpm typecheck && pnpm exec biome lint . && pnpm test`
must be green, then add a `## [date] ingest | REMEDIATION.md phase N` entry to `.wiki/log.md`.

## Environment gotchas (these cost real time — read them)

1. **Local `pnpm lint` is broken (CRLF).** `core.autocrlf=true` + `biome.json`
   `lineEnding:"lf"` ⇒ `biome check .` reports a format diff on *every* file locally. CI
   runs on Linux (LF) and passes. **Verify locally with `pnpm exec biome lint .`**
   (linter rules only — no formatter). `.ts` files are already LF on disk; only
   `.wiki/*.md` are CRLF. (Logged in `BACKLOG.md` → Tooling/DX.)

2. **`pnpm typecheck` needs a fresh `pnpm build` first.** The satellite packages
   (react/persist/entities/…) and the `integration` suite typecheck `@kontsedal/olas-*`
   against the built `dist/*.d.ts` (via package `exports`), **not** src. After changing
   core src *types*, run `pnpm build` before the full `pnpm typecheck`, or you'll get
   stale/`cannot find module` errors. `pnpm --filter "@kontsedal/olas-core" typecheck`
   alone uses src and is fine for quick core-only checks. (Real pre-existing gap — CI runs
   typecheck *before* build; logged in `BACKLOG.md` for **T7.2** to fix, not now.)

3. **Tests run against SRC, typecheck against DIST.** `vitest.config.ts` aliases
   `@kontsedal/olas-*` → src and defines `__DEV__`. So a test can pass while typecheck
   fails (or vice-versa). **Always run both.** Do NOT add tsconfig `paths` → src (tried it;
   it pulls core src into each satellite's `rootDir` and `__DEV__` isn't declared there).

4. **The Edit tool can't match some "spaces".** A few source strings contain a char that
   *renders* as a space but isn't (e.g. `devtools.ts` `pathKey` joins with a literal
   `'\0'`; `define.ts` `assignQueryId` uses a leading-space id). When `Edit` fails to match
   text that looks correct, inspect bytes: `sed -n 'Np' <file> | od -c`, and rewrite by
   pattern with `perl -i -pe 's/…/…/' <file>`.

5. **Big re-indents:** after wrapping a large block (e.g. in `untracked(() => …)`), run
   `pnpm exec biome format --write <file>` to fix indentation. It also converts that file
   to LF — invisible in `git diff` under autocrlf, so the commit stays minimal. Use
   `biome check --write <file>` when you added an import (it runs organizeImports too).

6. Ignore the **GitNexus "index is stale"** hook noise — not relevant to this work.

## Decisions / deviations already made (don't re-litigate)

- **T1.1 deviation:** the plan suggested making public `query.setData` untracked too. It's
  the exact mechanism `onMutate` uses for rollback, so untracking it breaks optimistic
  updates (and the acceptance criteria). Only the plugin/remote paths (`applyRemoteSetData`,
  `setEntryData`) were made `{ track: false }`. Public setData stays tracked.
- **T1.2:** every query now has an internal `__id = spec.queryId ?? auto-counter`
  (`define.ts`). Hydration buffer is keyed `JSON.stringify([id, hash])`. Hand-authored
  `DehydratedState` payloads must set `id` per entry = the query's `queryId`.
- **T2.8 pathKey** was **could-not-reproduce** (`[?]` in REMEDIATION) — it already joins
  with `'\0'`; the audit misread the NUL as a space.
- **Wiki staleness:** ~40 pages are legitimately >60 days stale. Do NOT blanket-bump
  `last_verified` — resolve per-phase as you touch covered code, plus the final T7.3 sweep.
  `pnpm wiki:lint` should stay **0 errors** (warnings are fine).

## Progress ledger

| Phase | Tasks | Status |
|-------|-------|--------|
| 0 — infra | T0.1–T0.4 | ✅ done |
| 1 — query criticals | T1.1, T1.2 | ✅ done |
| 2 — lifecycle criticals+majors | T2.1–T2.8 | ✅ done (T2.8 pathKey = `[?]`) |
| 3 — query majors | T3.1–T3.9 | ✅ done |
| 4 — React adapter | T4.1–T4.7 | ✅ done (T4.7 disabled+suspense = `[?]`) |
| 5 — forms | T5.1–T5.3 | ✅ done |
| 6 — satellites | T6.1–T6.7 | ✅ done |
| 7 — delivery/docs/release | T7.1–T7.3 | ⬜ (next) |
| 8 — devtools overhaul | T8.1–T8.10 (8A–8D) | ⬜ |

**Next up — Phase 7 (delivery/docs/release), T7.1–T7.3.** Mostly CI/docs work — safe to do or
delegate — EXCEPT the final publish. REMEDIATION lines ~780-824.

- **T7.1 — un-wedge the release pipeline.** npm is frozen at **0.0.6** (2026-05-21) while the
  repo is at 0.0.15; changesets abandoned after 0.0.6 (no changelogs/tags for 9 versions).
  (a) Back-fill `CHANGELOG.md` per package for 0.0.7–0.0.15 (summarize from `git log --oneline`)
  and fix the stale `# @olas/core` / `# @olas/react` headers → `@kontsedal/*`. (b) Create a
  changeset for the remediation release; version + tag via changesets going forward. (c) Add a
  CI publish job (changesets/action on `main`, `NPM_TOKEN` secret). (d) **PUBLISH — ⚠️
  outward-facing, irreversible, needs the user's explicit go-ahead. Do (a)–(c), then STOP and
  ask.** Honest combined changelog (many behavior changes, but 0.x = patch/minor).
- **T7.2 — verify what you ship.** `publint` + `@arethetypeswrong/cli` per package in CI (after
  build); a dist smoke test (import ESM + require CJS each built package, touch one export);
  grep built `dist/*.mjs` for a `__DEV__` leftover (should be none — `dev-flag.test.ts` only
  tests the vitest define, not the artifact); `engines: { node: ">=18" }` on every published
  package.json; coverage thresholds in `vitest.config.ts` (start at current, ratchet).
- **T7.3 — documentation debt.** API.md is frozen at ~0.0.4 — add mutation-queue, router,
  `ctx.session`/`collection`/`lazyChild`, suspense option, `HydrationBoundary`, streaming SSR,
  `indexedDbAdapter`, plus this plan's additions (`Mutation.status`, `query.cancel`, `isPaused`,
  `FormIssue`, `mustBeTrue`, `TimingSignal.dispose`, persist `version`/`migrate`/`onError`,
  mutation-queue `onReplaySettle`/`replayNow`, realtime `'unknown'`). README fixes (Windows `\`
  in package-table links; stale "React adapter ~230 lines"). `packages/realtime/package.json`
  description says `defineLiveStream` (export is `useLiveStream`); `packages/persist` desc omits
  `indexedDbAdapter`. `regressions.test.ts:3` cites nonexistent `ASSESSMENT.md`. `query.test.ts`
  raw-`Promise.resolve()` flush → `vi.waitFor`. **Wiki sweep**: bump stale `last_verified` on
  pages this plan touched, **add the missing `.wiki/modules/router.md`** (T6.6 left it), confirm
  the T2.1 pitfall page exists, final `log.md` ingest. This is the big-but-mechanical one.

**Then Phase 8 — devtools overhaul (T8.1–T8.10, sub-phases 8A–8D).** A large, ambitious feature
build (causal-chain inspector, subscription/effect tracing, live actions) — NOT bug fixes.
Treat it as its own project; read the Phase 8 preamble in REMEDIATION carefully first. T6.3
already fixed the outright devtools bugs, so Phase 8 is purely additive.

**Delegation pattern that worked well this phase:** T6.3–T6.6 were each executed by a `fork`
subagent (inherits full context → same test-first workflow + commit conventions) and
independently gate-verified afterward. Instruct the fork NOT to touch `handoff.md` /
`.wiki/log.md`, then verify `pnpm test` + `pnpm exec biome lint .` + `pnpm wiki:lint` (and
`build`+`typecheck` if core changed) before trusting it. Great when context is tight.

**Note:** `REMEDIATION.md` picked up a stray NUL byte somewhere (git shows it as `Bin` in
diffs; the Read/Edit tools handle it fine). It's transient (deleted at the end), so not worth
chasing — just don't expect a text diff for it.

**Phase 6 notes (satellite packages — leaving core):**
- Phase 6 = T6.1–T6.7, one package each: persist (T6.1), mutation-queue (T6.2), devtools
  (T6.3), cross-tab (T6.4), zod (T6.5), router (T6.6), realtime (T6.7). Each has its OWN
  test dir + README + `.wiki/modules/<pkg>.md`.
- **jsdom vs node env:** persist/devtools/react tests need a DOM (`indexedDB`, `localStorage`,
  `BroadcastChannel`, `navigator`). Check each package's `vitest` env; core is node-only.
- Satellites import `@kontsedal/olas-core` via the vitest alias → **src** for tests but
  **dist** for typecheck (handoff gotcha #2/#3): after changing core, `pnpm build` before the
  full `pnpm typecheck`.
- T6.2 (mutation-queue) is the heaviest — Web Locks / localStorage lease, `online` replay,
  cache reconciliation, and a **README demotion** ("best-effort" not "durable") until it all
  ships. T6.4 (cross-tab) removes the `'infinite'|'both'` option values (type-level) + dev-warn.

**Phase 5 recap (just completed):** new public surface — `FormIssue` / `ValidatorResult`
types + `mustBeTrue` validator; `Validator<T>` return widened to allow `FormIssue[]`. Full
details in `.wiki/log.md` (phase 5 ingest). Key behavior changes: form-level validators can
target fields by path (T5.2); `required(false)` now passes (use `mustBeTrue` for checkboxes);
`isValid` holds last-known validity while `isValidating` (no submit-button strobe, T5.3).
`packages/react/src/streaming.ts` + `packages/core/src/query/define.ts` are UTF-16/NUL-byte
files (show as `Bin` in git diffs; Edit tool handles them — not corruption).

## Handy commands

```bash
pnpm vitest run packages/core/tests/regressions.test.ts -t "R-Q1"   # one regression group
pnpm --filter "@kontsedal/olas-core" typecheck                       # quick core-only typecheck
pnpm build && pnpm typecheck                                          # full typecheck (needs dist)
pnpm exec biome lint .                                                # local lint (rules only)
pnpm wiki:lint                                                        # 0 errors expected
git log --oneline main..HEAD                                          # what this branch has done
```
