# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read this first

Three artifacts in this repo own different kinds of truth. Keep them strictly separated.

1. **`SPEC.md`** — the design **contract**. Describes what *is*. When code and spec disagree, the spec wins unless a test pins the current behavior on purpose. Section pointers (e.g. "§6.1", "§5.7") are canonical citations. SPEC.md never contains "we'll add this later" notes — those go in BACKLOG.md.
2. **`.wiki/`** — the codebase wiki (pattern in `WIKI_SPEC.md`). Synthesis of how the code is structured, why it's that way, and what's known to be true about it. **Always start a session by reading `.wiki/index.md`** — it points to every other page. The wiki is faster, cheaper, and more accurate than grepping the source.
3. **`BACKLOG.md`** — the **only** place future work, ideas, and stray thoughts live. See "The BACKLOG protocol" below for the rule.

Current implementation status: all eight published packages exist and ship — `@kontsedal/olas-core` (signals, controllers, queries, mutations, forms, SSR, `defineScope`), `@kontsedal/olas-react` (Provider + hooks + keep-alive), `@kontsedal/olas-zod`, `@kontsedal/olas-persist`, `@kontsedal/olas-devtools` (in-app panel + floating launcher), `@kontsedal/olas-cross-tab` (BroadcastChannel cache sync), `@kontsedal/olas-entities` (entity normalization plugin), `@kontsedal/olas-realtime` (realtime patcher + live streams). 436 lib tests across 37 files + the `examples/` apps (kanban, reader-ssr, stock-ticker, virtualized-table). Don't tear down "unused" scaffolding without checking; some pieces anticipate work that hasn't landed yet — `BACKLOG.md` lists what's outstanding.

## Commands

```bash
pnpm install                                       # link workspace + install deps
pnpm typecheck                                     # tsc --noEmit per package
pnpm lint                                          # biome check .
pnpm exec biome check --write .                    # auto-fix lint + format
pnpm test                                          # vitest run (all packages)
pnpm test:watch                                    # vitest watch
pnpm build                                         # tsdown per package → dist/{mjs,cjs,d.mts,d.cts}

pnpm vitest run packages/core/tests/query.test.ts  # run one test file
pnpm vitest run -t "race protection"               # run by test-name substring

pnpm wiki:lint                                     # check .wiki/ for broken citations, orphans, stale pages
```

CI = `install → typecheck → lint → test → build`. Reproducing CI locally is the five commands above in order.

## Workspace layout

```
packages/
  core/       # @kontsedal/olas-core      — signals, controllers, queries, mutations, forms, SSR
  react/      # @kontsedal/olas-react     — OlasProvider, useRoot/useController/useQuery/useField, KeepAlive, useSuspendOnHidden
  persist/    # @kontsedal/olas-persist   — usePersisted + localStorage adapter
  zod/        # @kontsedal/olas-zod       — zodValidator, formFromZod
  devtools/   # @kontsedal/olas-devtools  — in-app DevtoolsPanel + floating launcher
  cross-tab/  # @kontsedal/olas-cross-tab — BroadcastChannel-backed cross-tab cache sync (QueryClientPlugin)
  entities/   # @kontsedal/olas-entities  — defineEntity + auto-walk + reverse-index backprop (QueryClientPlugin)
  realtime/   # @kontsedal/olas-realtime  — useRealtimePatcher + useLiveStream over a consumer-supplied RealtimeService
```

Tests import workspace packages via aliases declared in `vitest.config.ts` — pointed at each package's `src/index.ts` (and `core/src/testing.ts`), so tests run without building `dist/`. The published `dist/` is what consumers see; the alias is dev-only.

`@kontsedal/olas-core/testing` is the only sub-path export — `createTestController` and other test-only helpers live there. Importing it in production code is a smell; the sub-path makes it grep-able.

---

# The wiki schema

This repo follows the **codebase wiki pattern** described in `WIKI_SPEC.md`. The pattern: instead of re-deriving understanding from raw files every session, maintain a persistent, agent-authored wiki that compounds across PRs. The rest of this CLAUDE.md is the **schema** — your operating manual for that wiki.

## Layout

```
.wiki/
├── index.md              # catalog — read this first on every session
├── log.md                # chronological append-only record (ingests, decisions, lint passes)
├── overview.md           # high-level architecture in prose
├── glossary.md           # domain vocabulary
├── modules/              # one page per significant package or subdirectory
├── entities/             # important classes / types / functions referenced across modules
├── flows/                # processes that span files (subscription, mutation, SSR, etc.)
├── decisions/            # why-X-not-Y, with the reasoning preserved
├── pitfalls/             # bug patterns, footguns, surprising behaviors
└── candidates/           # staging for low-confidence inferences (NOT trusted)
    ├── modules/
    ├── entities/
    ├── flows/
    ├── decisions/
    └── pitfalls/
```

## Page types

| Type | What it documents | Example |
|------|-------------------|---------|
| **module** | A significant package or subdirectory: purpose, public surface, key types, internal invariants | `modules/query.md` covers `packages/core/src/query/` |
| **entity** | A class/type/function referenced across modules; what a new contributor needs before reading callers | `entities/entry.md` covers the `Entry<T>` state machine |
| **flow** | A process that spans files — request lifecycles, lifecycle transitions, multi-step interactions | `flows/query-subscription.md` covers `ctx.use → bindEntry → Entry → AsyncState` |
| **decision** | The *why* behind a non-obvious design choice. Code refactors don't invalidate these — that's the point | `decisions/per-root-query-client.md` |
| **pitfall** | Bug patterns and surprising behaviors. Every "watch out for…" goes here | `pitfalls/callargs-vs-keyargs.md` |
| **glossary** | Single page of domain vocabulary | `glossary.md` |
| **overview** | Single page giving the current high-level understanding | `overview.md` |

Use whichever type fits. If something doesn't fit, ask before inventing a new type.

## Frontmatter — required on every wiki page

```markdown
---
name: short-kebab-case-slug
description: One sentence — what this page is about. Read by the index.
type: module | entity | flow | decision | pitfall | glossary | overview
covers:
  - packages/core/src/query/entry.ts
  - packages/core/src/query/client.ts:50-150
edges:
  - { type: uses, target: entities/query-client.md }
  - { type: tested-by, target: ../packages/core/tests/query.test.ts }
last_verified: 2026-05-18
confidence: high
---
```

- **`covers`** — file paths or `path:start-end` ranges this page documents. When those lines change, lint should flag the page for re-verification. Be specific: cite ranges, not whole files, when only part of a file matters.
- **`edges`** — typed links to other pages. Types: `uses` / `tested-by` / `supersedes` / `contradicts` / `documented-in` / `related` (last one only when nothing else fits).
- **`confidence`** — three levels with concrete tests:
  - `high` — page is verifiable against source AND has a referenced test (or spec section) pinning the behavior. Multi-source.
  - `medium` — page is synthesis (a "how this works" narrative) derived from reading code, but no independent verification (peer review, separate test, spec § citation) has confirmed the synthesis. **Default for anything authored in the same session as the code it describes.**
  - `candidate` — speculation. One file cited, no confirming test, no spec section. Lives in `.wiki/candidates/`. Excluded from authoritative queries.
- **`last_verified`** — ISO date (YYYY-MM-DD). Update when you re-read the covered code and confirm the page is still accurate.

**Bootstrap caveat.** Wiki pages dated in the project bootstrap window (roughly `2026-05-18` through `2026-05-20`) were authored by the same agent that wrote the implementation, in the same session. Even pages marked `high` haven't had independent review. When you encounter a `high`-confidence page whose `last_verified` falls before the first independent-review session and your session is the next opportunity for verification, treat the page as `medium` for the purposes of trust — read the covered code, confirm the claims, and bump `last_verified` if they hold. If they don't, fix the page or demote it.

In page bodies, prefer **citations as `path:line` or `path:start-end`** over prose references. `query/entry.ts:47-62` beats "the fetch loop in the entry module". Citations are mechanically dereference-able.

## Operations — when to do what

### Ingest

New information enters the wiki here.

- **Commit ingest** — when finishing a non-trivial change, read the diff, identify affected pages by `covers:`, update them, bump `last_verified`. Add new pages for new modules / entities. Add a `log.md` entry: `## [YYYY-MM-DD HH:MM] ingest | <short summary>`.
- **Conversation ingest** — when the user explains *why* something is the way it is, or describes a bug / constraint / past attempt, file it. Usually a pitfall or decision page. Don't let context die in chat.
- **External ingest** — bug reports, runtime issues, surprising library behavior. Same treatment.

### Query

Before reading source code, read the wiki:

1. Read `.wiki/index.md`. Identify candidate pages.
2. Read those pages.
3. Follow `covers:` citations to specific file ranges.
4. Read only the cited ranges, not whole files.
5. Answer / act.

This inverts the normal "grep → read → synthesize" loop. The synthesis already exists; the wiki points you at the exact code.

If a query produces a useful new synthesis (comparison, walk-through, inferred pattern), file it back as a page. The wiki compounds on use, not just on commits.

### Lint

Run `pnpm wiki:lint`. The script in `scripts/wiki-lint.ts` checks:

- Required frontmatter fields present (`name`, `description`, `type`, `last_verified`, `confidence`).
- `confidence` is one of `high` / `medium` / `candidate`.
- `last_verified` is a valid ISO date.
- Every `covers:` path exists. If a line range is given (`path:start-end` or `path:N`), the file is long enough.
- Every `edges:` target resolves to an existing file (path relative to the page).
- Edge `type` is one of `uses` / `tested-by` / `supersedes` / `contradicts` / `documented-in` / `related`.
- Orphans — pages not linked from `index.md` or any other page's edges/body.
- Staleness — pages whose `last_verified` is older than 60 days.
- Drift — covered files modified (per git log) after the page's `last_verified`.

Exit code: 0 on warnings only, 1 if any errors.

Additionally, do passes that the linter can't automate:

- Read covered code and confirm the page's claims still match.
- Look for two pages making conflicting claims → flag via a `contradicts` edge.
- Look for modules / public APIs without coverage.
- Promote candidates with accumulated evidence to authoritative.
- Re-confirm `high`-confidence pages dated before your session began (see bootstrap caveat above).

Cadence: before a non-trivial PR; after a refactor that touches multiple modules; opportunistically when you notice drift.

## Candidate staging

The dangerous failure mode is **confident wrongness** — a page asserts something incorrect with `high` confidence and every query propagates the error.

A page goes into `.wiki/candidates/<type>/` (mirroring the main layout) when:

- The agent inferred it from code rather than being told.
- Evidence is thin: one file cited, no confirming test, no spec section.
- Confidence is `candidate`.

Candidates are **excluded from authoritative query** — read them when explicitly looking, but don't surface them as facts. Promote to the main wiki when:

- The user confirms.
- Independent evidence accumulates (same inference from N sources).
- A test or spec section confirms.

Move via `git mv`, change `confidence`, update incoming edges.

## When to deviate

This schema is a starting point, not a contract. If a page doesn't fit a type, ask. If the layout starts feeling wrong, raise it — the schema is iterable. The goal is a wiki that's useful to the next session, not bureaucratic compliance.

---

# The BACKLOG protocol

`BACKLOG.md` at the repo root is the **only** place where future work, follow-ups, ideas-in-progress, and "we should also…" thoughts live.

**Rule:** if a thought is about *something not yet done* — a follow-up, a refactor idea, a wishlist API, a footnote you noticed while working on something else — it goes in `BACKLOG.md`. It does **not** go in:

- `SPEC.md` — the spec is the contract for what *is*. No roadmap, no "deferred to post-v1," no "future package."
- `CLAUDE.md` — operating instructions only. No backlog items.
- `.wiki/` — describes the codebase as it stands.
- Commit messages or PR descriptions only — those vanish from regular reading paths.
- Code comments (`// TODO`, `// later we should…`) — invisible at a glance.

When this matters most: **mid-task drift**. You're fixing a typecheck error and notice an unrelated rough edge in a neighbouring file. Don't fix it (that grows scope). Don't forget it. Append a one-liner to `BACKLOG.md` under the appropriate section (or "Loose ends" if it doesn't fit), then return to the task.

When a backlog item lands, **remove the entry** — the wiki page, CHANGELOG, and (if it amends the spec) SPEC.md section are the durable trail. When you kill an item, mark `[dropped]` with the reason and leave it in place; that reasoning matters next time the idea resurfaces.

If a backlog item turns into a real plan with a date, that's still fine — keep it in BACKLOG.md with `[planned]` status. It graduates to SPEC.md only when the design is committed and (usually) implemented.

---

# Codebase-specific gotchas (the quick list — full details in `.wiki/pitfalls/`)

- **`callArgs` vs `keyArgs` in `ClientEntry`** — original args go to the fetcher; `spec.key(...)` output goes to the hash. They are not the same. See `.wiki/pitfalls/callargs-vs-keyargs.md`.
- **`Field<T>.value` returns `T`, but `Form.value` and `FieldArray.value` are `ReadSignal<...>`.** Form traversal code branches on this. See `.wiki/pitfalls/field-value-shape.md`.
- **`latest-wins` mutations roll back the previous snapshot synchronously before calling the new `onMutate`** — not on the previous run's catch. Doing it later stacks snapshots wrong. See `.wiki/pitfalls/latest-wins-rollback-order.md`.
- **`isStale` cannot be a `Date.now()` computed** — its deps don't change as time passes. Must be timer-driven. See `.wiki/pitfalls/isstale-needs-timer.md`.
- **Mutations race against their abort signal** so misbehaving mutate fns can't block forever. See `.wiki/pitfalls/raceabort-for-misbehaving-mutate.md`.
- **`ctx.field('')` infers `Field<''>`** because of literal narrowing. Annotate: `ctx.field<string>('')`. See `.wiki/pitfalls/literal-type-narrowing.md`.
- **`@preact/signals-core`'s overloaded `signal()` gives `Signal<T | undefined>`** through `ReturnType` because the last overload wins. We use `PreactSignal<T>` directly to dodge it. See `.wiki/pitfalls/preact-signals-overload-return.md`.

---

# Conventions

- **Don't commit `dist/`.** `tsdown` cleans on every build; `.gitignore` excludes it. `pnpm-lock.yaml` IS committed.
- **`@preact/signals-core` is a peer dep on `@kontsedal/olas-core`** — declared in both `peerDependencies` and `devDependencies`. Consumers install it; the library does not bundle it.
- **biome config in `biome.json`** (currently v2.x — see `package.json`) — two rules are intentionally off: `noExplicitAny` (the wrapper types need it) and `noConfusingVoidType` (matches the spec's effect signature `() => void | (() => void)`). Don't re-enable them.
- **The spec uses `§N.M` to cite sections.** Page bodies should do the same — `(spec §6.1)` is more useful than "see the mutations section".
