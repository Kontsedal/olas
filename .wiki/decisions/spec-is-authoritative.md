---
name: spec-is-authoritative
description: When SPEC.md and code disagree, the spec wins. Why and how.
type: decision
covers:
  - SPEC.md
  - CLAUDE.md
edges:
  - { type: documented-in, target: ../../SPEC.md }
last_verified: 2026-05-18
confidence: high
---

# SPEC.md is authoritative

## The rule

When the spec and code disagree, the spec wins — unless a test pins the current code's behavior intentionally.

## Why

This codebase was built spec-first. SPEC.md is ~3000 lines of design rationale, type-level surface, and worked examples written before the implementation. It explains *why* decisions were made (with §-numbered citations) and *what semantics consumers should expect*.

Two consequences flow from spec-first:

- **The spec is more stable than the code.** Refactors update the code; the spec stays. If you find disagreement, the resolution is almost always "fix the code, not the spec."
- **The spec carries information the code can't.** "We considered X and rejected it because Y" doesn't survive a refactor unless it's in the spec or a decision wiki page. Many "why is this so weird?" questions resolve by reading the right §.

## What to do when you find a disagreement

1. Cite the spec section.
2. Decide: is this an implementation bug (fix the code), or did the spec drift (fix the spec)? Implementation bugs are the default assumption.
3. If you change the spec, file a decision wiki page explaining what changed and why. The spec moving is rare enough that it deserves a record.

## What this doesn't mean

The spec is not infallible — it has known gaps and ambiguities (notably around `setData` cross-client semantics, the "prefetch with no clients" case, and reactive `initial` for forms). When the spec is silent or ambiguous, the codebase + tests pin the chosen interpretation, and **that pinning is binding**. Future Claudes shouldn't re-litigate pinned interpretations without a strong reason; document them in a decision wiki page instead.
