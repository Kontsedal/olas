# handoff.md — REMEDIATION.md execution, session handoff

**Transient file** (like `REMEDIATION.md`). Delete both when the remediation lands.
Written 2026-07-25 after completing Phases 0–4.

---

## TL;DR

- Working on branch **`remediation`** (off `main`). All work is committed.
- **Phases 0–4 DONE + T5.1 DONE** — 31 tasks (T0.1–T0.4, T1.1–T1.2, T2.1–T2.8, T3.1–T3.9,
  T4.1–T4.7, T5.1). Two `[?]` items along the way: T2.8 pathKey (could-not-reproduce),
  T4.7 disabled+suspense (could-not-implement-cleanly → BACKLOG).
- Pipeline is **green**: `pnpm test` → 691/691, typecheck clean, biome lint clean.
- **Next task: T5.2** (Phase 5 — forms, mid-phase). The full task list + "decisions
  made" live in `REMEDIATION.md`; the checkboxes there are the source of truth.

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
| 5 — forms | T5.1–T5.3 | 🔶 in progress (T5.1 ✅; T5.2, T5.3 next) |
| 6 — satellites | T6.1–T6.7 | ⬜ |
| 7 — delivery/docs/release | T7.1–T7.3 | ⬜ |
| 8 — devtools overhaul | T8.1–T8.10 (8A–8D) | ⬜ |

**Next up — T5.2** (`packages/core/src/forms/form.ts` + `validators.ts`): **[MAJOR]**
cross-field validation can't target fields; Standard Schema issues lose their `path`. A
form-level validator returns one `string | null`, so "passwords must match" can't land on
the confirm field; a whole-form Zod schema collapses to one anonymous top-level string.
Fix (decision made in REMEDIATION.md): extend the form-level validator return to
`string | null | FormIssue[]` (`FormIssue = { path: (string|number)[]; message: string }`);
non-empty-path issues route into a NEW per-field `formErrors` signal (a third channel beside
validator + server errors), merged into the field's visible `errors`, cleared on the next
form-level run; empty-path issues → `topLevelErrors`. Rewrite the Standard Schema wrapper
(`validators.ts:16-30`) to return ALL issues as `FormIssue[]`. Existing plumbing to reuse:
`form.setErrors(pathMap)` + `resolvePath` (`form.ts:416-426`). SPEC §8 validators; API.md;
`.wiki/modules/forms.md` + `zod.md`. Then **T5.3** — forms minor batch (validateOn tests,
`required(false)` passes, `isValid` during `isValidating`, reset-batch, thrown-validator
message in prod). That completes Phase 5 → run the phase gate + `.wiki/log.md` ingest.

**Phase 5 notes (forms — `packages/core/src/forms/`, back to core):**
- Core tests (node env, NOT jsdom) in `packages/core/tests/` — forms tests in
  `form*.test.ts`, `field*.test.ts`. Regressions go in `regressions.test.ts` (`R-F5.x` tag).
- `Field<T>.value` returns `T`; `Form.value` / `FieldArray.value` are `ReadSignal<...>`
  (pitfall `field-value-shape.md`). Form traversal branches on this.
- `__DEV__` IS available in core (unlike react) — use it for dev-only warnings.
- T5.1 added `FieldArray.structurallyDirty$` (isDirty = structural || anyItemDirty).

**Phase 4 recap (just completed):** new public surface — `Mutation.status` (core), which
`useMutation`'s `isSuccess`/`isIdle`/`isError` derive from. Full details in `.wiki/log.md`
(phase 4 ingest entry). `packages/react/src/streaming.ts` + `packages/core/src/query/define.ts`
are UTF-16/NUL-byte files (show as `Bin` in git diffs; Edit tool handles them — not corruption).

## Handy commands

```bash
pnpm vitest run packages/core/tests/regressions.test.ts -t "R-Q1"   # one regression group
pnpm --filter "@kontsedal/olas-core" typecheck                       # quick core-only typecheck
pnpm build && pnpm typecheck                                          # full typecheck (needs dist)
pnpm exec biome lint .                                                # local lint (rules only)
pnpm wiki:lint                                                        # 0 errors expected
git log --oneline main..HEAD                                          # what this branch has done
```
