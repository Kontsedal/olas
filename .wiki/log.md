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
