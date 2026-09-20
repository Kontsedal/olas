---
name: prose-rules
description: The writing rules every .md file in this repo follows, what `pnpm prose:lint` enforces, and the four things it flags that we leave alone.
type: decision
covers:
  - scripts/prose-lint.mjs
  - CLAUDE.md
edges:
  - { type: documented-in, target: ../../CLAUDE.md }
  - { type: related, target: spec-is-authoritative.md }
  - { type: related, target: ../../WIKI_SPEC.md }
last_verified: 2026-09-20
confidence: medium
---

# Prose rules

## The rule

Every Markdown file in this repo follows one style: **one fact per sentence, named actor, no word that carries no fact.** `pnpm prose:lint` checks the mechanical half.

The rules come from the fonbnk codebase wiki, under "Do not write slop" and "Write in ASD-STE100 Simplified Technical English". `scripts/prose-lint.mjs` is a port of that repo's `wiki-lint.js --style`, with the same thresholds.

## What the linter checks

It reads prose only. Frontmatter, fenced code, tables, headings and HTML comments are dropped first. Inline code and link targets collapse to one token, and a long quotation is blanked, because quoting someone accurately is not a style error.

| Finding | Rule |
|---|---|
| `banned` | No "note that", "worth noting", "here's the thing", "not just X but Y", "leverage", "unpack", "holistic". No saying what a thing is not before saying what it is. |
| `hedge` | No "just", "simply", "actually", "essentially", "genuinely", "effectively" and the rest of that list. |
| `slash-or` | No slash standing in for "or". Write which relationship you mean. |
| `stacked-brackets` | One bracket pair per sentence, or none. |
| `long-sentence` | 30 words, as a ceiling. |
| `lazy-extreme` | No "always", "never", "every single", "nobody" unless you checked. If you checked, say where. |
| `em-dash` | Three clause-joining em dashes per 1000 words. A dash in a heading, a table cell or a list label is free. |

Two rules the linter cannot see, from ASD-STE100. Use the active voice and name the actor: "the cron writes the row", not "the row is written". Keep one word for one idea on every page, and reuse the word the code already uses.

**The limits are a ceiling, not a target.** A page of six-word sentences is harder to read than the long text it replaced. Join related facts with "and", "but", "so" and "because", and use the full sentence when the thought needs it.

## What we leave alone, and why

A clean run is not the goal. Four shapes are flagged and correct, and chasing them to zero would make the docs worse.

**Em dashes stay.** They are half of what the linter finds here and they mostly earn their place. Bringing a file inside budget is fine; replacing every one is a voice change, not a style fix. This was a deliberate call, not an oversight.

**An absolute that is absolute stays.** Most `lazy-extreme` hits in `SPEC.md` and `API.md` are contract language a test pins: "`peek` never creates an entry", "`invalidate` always marks the entry stale", "an explicit per-query field always wins". Hedging those would make the spec less precise. Fix the rhetorical use instead, and replace a vague "nobody" with the actor: "no subscriber is watching".

**A code citation in parentheses stays.** The written rule exempts it. The linter still counts it, so a sentence with one citation and one real parenthetical reports two bracket groups.

**Terse annotations in `log.md` stay.** A changelog entry like "`store.test.ts` (25 tests)" reads better than the sentence it would become. That accounts for most of the remaining `stacked-brackets` in that file.

## How to run it

```bash
pnpm prose:lint                      # every .md outside node_modules
pnpm prose:lint README.md            # one file
pnpm prose:lint --verbose            # every finding, not a sample
pnpm prose:lint --summary            # per-file totals
```

It is **opt-in**. No hook runs it and CI does not call it, so it cannot block a commit. Run it on what you changed and clear what you added. `CHANGELOG.md` files are skipped, because changesets regenerates them.

## The state it was left in

The 2026-09-20 pass took the repo from 1989 findings to 1042 across 79 files. `slash-or` and `banned` went to zero. `hedge` went from 92 to 8, and every one that remains is temporal ("the rows the user just added") or inside a quotation. `stacked-brackets` went from 194 to 46 and `long-sentence` from 245 to 54. `lazy-extreme` and `em-dash` were left high on purpose, for the reasons above.

Two lessons worth keeping.

The `slash-or` fix could not be scripted alone. A slash at the end of a wrapped line left half a list converted. The choice between "and" and "or" is a judgment, and the regex got it wrong in the enum cases. Review the diff of any scripted prose change before you keep it.

A rule written into a wiki page is a claim like any other. This pass put a false one into `pitfalls/isstale-needs-timer.md`, claiming `refetchInterval` needed no overflow guard, and had to correct it a day later.
