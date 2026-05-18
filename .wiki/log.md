# Wiki log

Chronological, append-only record of wiki activity. Greppable. Newest at the bottom.

Format: `## [YYYY-MM-DD HH:MM] <kind> | <short summary>` where `<kind>` ∈ {ingest, lint, candidate-promote, contradict, query-archive, schema-change}.

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
