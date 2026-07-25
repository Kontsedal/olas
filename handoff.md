# handoff.md — REMEDIATION.md execution, session handoff

**Transient file** (like `REMEDIATION.md`). Delete both when the remediation lands.
Written 2026-07-25; updated after completing Phase 6 (all satellite packages, T6.1–T6.7).

---

## TL;DR

- Working on branch **`remediation`** (off `main`). All work is committed.
- **Phases 0–7 DONE — 43 tasks** (T0.1–T0.4, T1.1–T1.2, T2.1–T2.8, T3.1–T3.9, T4.1–T4.7,
  T5.1–T5.3, T6.1–T6.7, T7.1–T7.3). Two `[?]` items along the way: T2.8 pathKey
  (could-not-reproduce), T4.7 disabled+suspense (could-not-implement-cleanly → BACKLOG).
- Pipeline is **green**: `pnpm test` → 751/751 (coverage gate green), typecheck clean, biome
  lint clean, `pnpm wiki:lint` 0 errors.
- **The remediation's core work is COMPLETE.** Only two things remain, **both intentionally
  deferred**:
  1. **`npm publish`** — maintainer-gated. T7.1 did all the prep (fixed CHANGELOG headers +
     backfill, a `patch` changeset, a `main`-only `NPM_TOKEN`-gated `release.yml`). To ship:
     add the `NPM_TOKEN` secret, `pnpm changeset version`, review, merge to `main` (CI
     publishes) — or publish manually. T7.1's Publish sub-item is left `[ ]` on purpose.
  2. **Phase 8 — devtools overhaul** (T8.1–T8.10): a large *additive feature* (not bug fixes),
     captured in `.wiki/candidates/decisions/devtools-overhaul.md`. Start there if pursued.
- **Do NOT delete `REMEDIATION.md` yet** — Publish + all of Phase 8 are still `[ ]`. When those
  land (or Phase 8 is formally dropped), fold leftovers into `BACKLOG.md` and delete it.

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
| 7 — delivery/docs/release | T7.1–T7.3 | ✅ done (npm publish deferred to maintainer) |
| 8 — devtools overhaul | T8.1–T8.10 (8A–8D) | ⬜ deferred → `.wiki/candidates/decisions/devtools-overhaul.md` |

**How to finish the two remaining deferred items:**

*Publish (T7.1 (d)) — all prep is committed.* npm is frozen at **0.0.6** while the repo is at
0.0.15. To ship the accumulated 0.0.7–0.0.15 + the remediation:
1. Add an `NPM_TOKEN` repo secret (npm automation token with publish rights).
2. `pnpm changeset version` — consumes `.changeset/remediation-correctness-pass.md`, bumps the
   10 published packages (patch), rewrites their CHANGELOGs. Review the diff.
3. Merge to `main` → `.github/workflows/release.yml` (`changesets/action`) publishes. Or
   publish manually after `pnpm build`. (Nothing auto-publishes today: the workflow is
   `main`-only and no-ops without the secret.)

*Phase 8 (devtools overhaul).* A large **additive feature**, not bug fixes — full design in
**`.wiki/candidates/decisions/devtools-overhaul.md`** (rescued from REMEDIATION so it survives
this file's deletion). Start with 8A (event-driven store + `causeId` correlation) — it's the
foundation everything else stands on. Read that candidate page + the Phase 8 preamble in
REMEDIATION first. T6.3 already fixed the outright devtools bugs, so this is purely additive.

**Delegation pattern (worked well for the satellite + Phase-7 tasks):** each was executed by a
`fork` subagent (inherits full context → same test-first workflow + commit conventions) and
independently gate-verified afterward. Instruct the fork NOT to touch `handoff.md` /
`.wiki/log.md`, then verify `pnpm test` + `pnpm exec biome lint .` + `pnpm wiki:lint` (and
`build`+`typecheck` if core changed) before trusting it. Great when context is tight.

**Note:** `REMEDIATION.md` picked up a stray NUL byte (git shows it as `Bin` in diffs; Read/Edit
handle it fine). Transient file → not worth chasing.

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
