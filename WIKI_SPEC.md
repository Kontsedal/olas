# The Codebase Wiki Pattern

A pattern for giving coding agents persistent, compounding understanding of a codebase — instead of forcing them to re-derive it from raw files on every prompt.

This document is intentionally abstract. It describes the idea, not a specific implementation. Share it with your coding agent and instantiate a version that fits your codebase, language, and tooling. The agent will figure out the specifics in collaboration with you.

---

## The core idea

Most interactions with a coding agent look like RAG over a filesystem: the agent grep-searches the repo, reads a handful of files, holds them in context just long enough to answer the question, and discards everything when the session ends. Next session, it does the same work over again. Nothing accumulates. Every explanation you give — *"the reason we do X is because of Y"*, *"we tried Z, it didn't work because…"* — dies in chat history the moment the conversation closes.

The codebase wiki pattern is different. The agent **incrementally builds and maintains a persistent wiki alongside the code** — a structured, interlinked collection of markdown pages capturing what the codebase is, why it's that way, and what's known to be true about it. When code changes, the agent updates affected pages. When you explain something, the agent files it. When the agent infers something it isn't sure about, the inference goes into a staging area until evidence accumulates.

The key shift: **the wiki is a persistent, compounding artifact that lives in the repo.** The architecture has already been mapped. The pitfalls have already been documented. The cross-references between modules already exist. The wiki keeps getting richer with every PR merged, every bug fixed, every design decision explained — and crucially, it stays *current*, because the cost of maintenance is paid by the agent, not by you.

You almost never write the wiki yourself. The agent writes it. Your job is to direct attention, confirm or reject inferences, and ask the right questions. The agent's job is the bookkeeping: summarizing, cross-referencing, filing, keeping pages in sync with code, flagging contradictions.

---

## Why this works for code specifically

Code has properties that make it both easier and harder to wiki than general knowledge:

**Easier:** code has structure the agent can mechanically verify. Every claim in the wiki can cite a specific file and line range. When those lines change, the cited claim is mechanically detectable as stale. The wiki has a feedback loop with reality that a wiki of, say, podcast notes does not.

**Harder:** code changes faster than most knowledge bases. A page written today can be wrong tomorrow if someone refactors. The pattern has to assume continuous drift and build maintenance into the agent's normal workflow, not as a separate task.

The pattern's payoff is highest when:

- The codebase is large enough that no single human holds all of it in their head.
- You return to the same codebase repeatedly across long time gaps (days, weeks, months).
- Multiple agents or contributors work on it, each starting from zero context.
- The codebase has non-obvious decisions, hard-won lessons, or domain logic that doesn't appear in the code itself.

It pays off less when the codebase is small, throwaway, or single-session.

---

## Architecture

There are three layers:

**Raw sources** — the codebase, dependencies, ADRs, PR history, issue threads, runtime logs, test outputs, design docs. The agent reads these but doesn't claim ownership of them. Code edits happen here through normal development; the wiki layer does not modify source code semantics.

**The wiki** — a directory of agent-authored markdown pages, version-controlled alongside the code. Pages cover modules, important entities (classes, types, functions), cross-cutting flows, decisions, pitfalls, and domain vocabulary. The agent creates pages, updates them on relevant changes, maintains cross-references, and keeps the index current. You read it; the agent writes it.

**The schema** — a configuration document (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, or whatever your agent reads) that teaches the agent the wiki conventions. What pages exist, what they cover, how to update them, when to lint, when to ingest. This file is what turns the agent from a stateless assistant into a disciplined wiki maintainer. You and the agent co-evolve it as you learn what works for your codebase.

---

## Page types

The page types below are a starting taxonomy. Most codebases need most of them; some need additional types specific to their domain. The schema document is where you declare which types exist and what each contains.

**Module pages.** One per significant module, package, or directory. What the module does, its public API, the key types it exposes, internal invariants, known gotchas. The unit of organization here should match how the team thinks about the code, not necessarily how it's physically structured on disk.

**Entity pages.** Important classes, types, interfaces, or functions that are referenced across modules. Anything a new contributor would need to understand before reading the code that uses it.

**Flow pages.** Anything that spans files — request lifecycles, data pipelines, auth flows, event handlers, background jobs. Flows are where the codebase's structure is hardest to recover from reading code, and where wiki pages add the most value.

**Decision pages.** The *why* behind the code. Often distilled from ADRs, PR discussions, or your own explanations. "Why we chose X over Y", "what we tried that didn't work", "what constraint forces this design". Decisions are the wiki content with the longest shelf life — code refactors don't invalidate them.

**Pitfall pages.** Bug patterns, footguns, surprising behaviors, lessons learned the hard way. Every time you fix a bug whose cause wasn't obvious from the code, that's a pitfall page. Every time you say "watch out for…", that's a pitfall page.

**Glossary.** Domain vocabulary that doesn't appear in code but is critical to understanding it. Especially valuable for codebases with heavy domain logic or jargon.

**Overview.** A single page giving the current high-level understanding of the codebase. Architecture diagram in prose, the major pieces and how they fit, the design philosophy. Updated as the codebase evolves.

---

## Operations

The agent's interaction with the wiki happens through three operations, each with multiple triggers.

### Ingest

New information enters the wiki through ingestion. For code, ingest has three distinct triggers:

**Commit ingest.** After a PR is merged (or a significant local change is made), the agent reads the diff, identifies affected wiki pages, and updates them. New module → new module page. Refactored flow → flow page updated. Removed function → entity page archived with a deprecation note linking to the replacement. This is the workhorse trigger — most wiki updates happen here.

**Conversation ingest.** When you explain something to the agent in chat, that explanation is wiki-worthy. The agent should recognize it ("here's some context that didn't exist in the wiki yet") and file it into the right page — usually a pitfall or decision page. Without this, hard-won context dies in chat history. With it, every explanation becomes durable.

**External ingest.** Bug reports, customer complaints, Slack threads, Stack Overflow findings, runtime incidents. Any external signal about the code becomes a candidate for wiki updates.

### Query

The agent reads the wiki before reading code. When a question arrives, the flow is:

1. Read `index.md` to find candidate pages.
2. Read those pages.
3. Follow citations to specific files and line ranges in the code.
4. Read only the cited ranges, not whole files.
5. Answer.

This inverts the usual order. Without a wiki, the agent reads code and then synthesizes. With a wiki, the synthesis already exists and points the agent to the exact code it needs. The token cost on complex questions drops substantially because exploration is replaced by directed lookup.

Good query answers can themselves become wiki pages. A comparison the agent generated, an analysis, a connection it discovered — these are valuable and shouldn't vanish into chat. Filing them back makes the wiki compound on use, not just on commits.

### Lint

The wiki health-checks itself periodically (a nightly cron, a pre-commit hook, or an on-demand command). Lint looks for:

- Pages whose cited line ranges no longer exist — stale, needs verification.
- Pages with no inbound links — orphans, probably obsolete.
- Contradictions between pages — flag for human review.
- Modules without pages, public APIs without entity pages — coverage gaps.
- Pitfalls older than N months with no recent confirmation — confidence decay.
- Candidate pages that have accumulated enough evidence to promote.

Lint is what keeps the wiki from drifting into confidently wrong. Without it, pages slowly diverge from code and the wiki becomes a liability. With it, drift is mechanically detectable and the agent has explicit work items to address.

---

## Two-way binding: the trust mechanism

The single most important adaptation of the general wiki pattern for code is **two-way binding between wiki pages and source files.**

Every page declares what code it covers via frontmatter:

```yaml
---
covers:
  - src/auth/middleware.ts
  - src/auth/session.ts:120-180
last_verified: 2026-05-15
confidence: high
---
```

This binding enables three things:

**Mechanical staleness detection.** When `src/auth/middleware.ts` changes, lint flags every page that covers it as needing re-verification. The wiki cannot quietly become wrong while the code moves underneath it.

**Bidirectional navigation.** Given a file, the agent can find all pages documenting it (`grep covers: src/auth/middleware.ts .wiki/`). Given a page, the agent jumps to specific cited lines, not whole files.

**Coverage measurement.** Lint can compute which source files have wiki coverage and which don't, surfacing gaps as a concrete number rather than a vague concern.

Citations inside page bodies should be file+line ranges, not prose references. `src/auth/middleware.ts:47-62`, not "see the auth middleware". When the agent fetches a citation, it fetches a specific range. When the range moves, lint catches it.

---

## Typed edges

Pages link to each other, but the *type* of link carries meaning the agent can use for query traversal. Untyped links collapse important distinctions; typed edges preserve them.

A useful starter taxonomy:

- `uses` — page A documents code that depends on what page B documents.
- `tested-by` — page A's claims are verified by the tests on page B.
- `supersedes` — page A replaces page B (which stays around with a deprecation note).
- `contradicts` — page A and page B make conflicting claims. Flagged for resolution.
- `documented-in` — page A is a summary of an external doc, ADR, or PR.
- `related` — fallback when none of the above apply (use sparingly).

Edges go in frontmatter, not just inline links:

```yaml
edges:
  - {type: uses, target: modules/sessions.md}
  - {type: supersedes, target: pitfalls/old-jwt-approach.md}
  - {type: tested-by, target: tests/auth-integration.md}
```

Typed edges turn the wiki into a real graph the agent can traverse purposefully. "Show me everything that *contradicts* this assumption" is a meaningfully different query from "show me everything *related to* this module."

---

## Candidate staging: handling low-confidence claims

The most dangerous failure mode for a coding agent's wiki is **confident wrongness.** If a page asserts something incorrect with high confidence, every future query that hits that page propagates the error.

The fix is a staging area for low-confidence claims:

```
.wiki/
├── modules/           ← authoritative
├── flows/             ← authoritative
└── candidates/        ← staging, not yet trusted
    ├── modules/
    └── flows/
```

A page goes into `candidates/` when:

- The agent inferred something from code rather than being told it.
- The evidence is thin (one cited file, no confirming tests, no PR discussion).
- The confidence score is below a threshold defined in the schema.

Candidates are excluded from authoritative queries, contradiction checks, and lint. They get promoted to the main wiki when:

- A human reviews and confirms them.
- Independent evidence accumulates (the same inference repeats from N different sources).
- Tests or runtime behavior confirms the claim.

This single mechanism prevents most "wiki rot" failure modes. The wiki stays trustworthy because untrusted content is mechanically segregated.

---

## Confidence and decay

Every page carries a confidence level in its frontmatter (`high` / `medium` / `candidate`) and a `last_verified` date. Lint uses both:

- Pages older than N months without re-verification get downgraded.
- Pages whose covered files have changed since `last_verified` get downgraded.
- Pages cited frequently across other pages without ever being challenged accumulate trust.

The exact decay policy belongs in the schema, not in the pattern. A fast-moving codebase might decay pages weekly; a stable one might leave them untouched for a year.

---

## Indexing and logging

Two special files help the agent and humans navigate the wiki as it grows.

**`index.md`** is content-oriented. A catalog of every page, grouped by type, with one-line summaries. The agent reads it first on every query to identify candidate pages. At small scale (a few hundred pages), the index is enough to find anything; at larger scales, you add proper search infrastructure on top. The agent updates the index on every ingest.

**`log.md`** is chronological. Append-only record of what happened: ingests, queries the agent thought were noteworthy, lint passes, candidate promotions, contradictions found. Useful prefix format: `## [2026-05-18 14:32] ingest | PR #142 | auth middleware refactor`. With consistent prefixes, the log is greppable with standard tools, and the agent can quickly understand what's been done recently.

---

## The schema document

The schema (e.g. `CLAUDE.md`) is the configuration file that makes everything above work. Without it, the agent doesn't know the wiki exists. With it, the agent operates as a disciplined wiki maintainer by default.

A schema document should specify:

- Wiki location and directory structure.
- Page types and what each contains.
- Frontmatter conventions (covers, edges, confidence, last_verified).
- When to ingest (which commits, which conversations).
- When to query the wiki vs. when to read code directly.
- How to handle low-confidence inferences (candidate staging rules).
- When and how to lint.
- The edge type taxonomy.

The schema is the single highest-leverage file in this pattern. A few hundred words there determines whether the agent does this consistently or sporadically. Iterate on it as you learn what works for your codebase.

---

## Suggested layout

```
repo/
├── src/                       ← raw source
├── CLAUDE.md                  ← schema
├── .wiki/
│   ├── index.md               ← catalog
│   ├── log.md                 ← chronological record
│   ├── overview.md            ← high-level codebase understanding
│   ├── modules/
│   │   ├── auth.md
│   │   └── billing.md
│   ├── entities/
│   │   └── user-session.md
│   ├── flows/
│   │   ├── login-flow.md
│   │   └── payment-pipeline.md
│   ├── decisions/
│   │   ├── why-mongo-not-postgres.md
│   │   └── why-monolith.md
│   ├── pitfalls/
│   │   ├── mongoose-cursor-leaks.md
│   │   └── timezone-handling.md
│   ├── glossary.md
│   └── candidates/            ← staging
│       └── modules/
│           └── inferred-cache-layer.md
```

This is a suggestion, not a prescription. Some codebases need fewer page types; some need more. The structure should reflect how the team thinks about the code.

---

## Why this works

The tedious part of maintaining understanding of a codebase isn't reading code or making changes — it's the bookkeeping. Keeping summaries current as code drifts, remembering which decisions were made and why, noticing when a new bug rhymes with an old one, maintaining cross-references between modules. Humans abandon this work because it scales worse than linear with codebase size. Coding agents don't get bored, don't forget cross-references, and can touch fifteen pages in one pass.

The human's job becomes what it should always have been: direct attention, make decisions, confirm or reject inferences, ask good questions. The agent does everything else.

This pattern is related in spirit to literate programming and to Conway's "documentation that lives with the code" idea — but neither of those solved who does the maintenance. The agent solves that. The wiki stays maintained because the maintainer is tireless.

---

## What this is not

**Not a replacement for code comments or docstrings.** Comments live with code and document local intent. The wiki documents emergent structure, cross-cutting concerns, and decisions that span files. Both are useful; they cover different ground.

**Not a replacement for ADRs.** ADRs are still the right place for major architectural decisions at the moment they're made. The wiki ingests ADRs into decision pages and keeps them cross-referenced with the code they describe. ADRs are sources; the wiki is synthesis.

**Not a replacement for tests.** Tests verify behavior; the wiki documents understanding. A pitfall page might reference the test that prevents the regression, but the page is for humans (and agents) trying to understand *why* the pitfall exists.

**Not a replacement for embedding-based code search.** At very large scale, you still want vector search or AST-aware indexing. The wiki is a synthesis layer on top of those, not a substitute. For small to moderate codebases, the index file is enough on its own.

---

## Note

This document describes a pattern, not a specific implementation. The exact directory structure, frontmatter schema, page taxonomy, edge types, and tooling will depend on your codebase, your agent, and your team's working style. Everything here is optional and modular — pick what's useful, ignore what isn't.

The right way to use this document is to share it with your coding agent and work together to instantiate a version that fits your project. The document's only job is to communicate the pattern. Your agent can figure out the rest.
