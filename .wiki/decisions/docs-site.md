---
name: docs-site
description: The VitePress docs site and the api-extractor reports — why the site syncs the repo docs instead of owning copies, how the reference is generated, what CI checks, and why deploying is manual.
type: decision
covers:
  - docs/.vitepress/config.mts
  - scripts/docs-sync.mjs
  - scripts/api-report.mjs
  - .github/workflows/docs.yml
  - .github/workflows/ci.yml
edges:
  - { type: related, target: typechecked-doc-snippets.md }
  - { type: related, target: esm-only-build.md }
  - { type: related, target: toolchain.md }
last_verified: 2026-09-25
confidence: medium
---

# The docs site and the API reports

## The decision

The site is VitePress, in `docs/`. It has three kinds of page:

| Kind | Where it comes from | In git |
|---|---|---|
| Guides | written in `docs/guide/` (getting-started, concepts, queries, mutations, forms, ssr, testing, performance) and `docs/index.md` | yes |
| Synced pages | `scripts/docs-sync.mjs` copies RECIPES, PLUGINS, MIGRATING and every package README into `docs/guide/`, `docs/adapters/` and `docs/packages/` | no |
| Reference | `api-documenter` renders the doc model that api-extractor writes, into `docs/reference/` | no |

Each published entry point also has an API report, `packages/*/etc/*.api.md`, checked in. `pnpm api:check` (`scripts/api-report.mjs`, in CI after `check:public-types`) fails when a report no longer matches the built `.d.ts`. `pnpm api:update` rewrites them.

## Why sync instead of moving the docs

The repo docs are what npm and GitHub readers see. `pnpm check:doc-snippets` keeps their code compiling (`typechecked-doc-snippets.md`). Moving them into `docs/` would split the audience, and copying them would drift. So the site reads them at build time, and each fact has one source.

The sync rewrites relative links, because a link written for `packages/react/README.md` is wrong on `/adapters/react` (`scripts/docs-sync.mjs`, `rewriteLink`). A link to another synced doc becomes that page's route. Any other link points at the file on GitHub. Code blocks are set aside first, so a link-shaped string in code stays as written. The guides themselves are checked by the snippet checker, which skips the synced copies.

API.md stays. The plan named the generated reference as a replacement for its reference sections, but API.md carries checked examples, gotchas and prose that api-documenter cannot produce. The two now sit side by side: API.md is the narrative reference, and `/reference/` has every export's exact signature.

## The API reports

- **One script, no per-package config.** `scripts/api-report.mjs` builds each api-extractor config in code from `package.json` `exports`, one per entry with `types`. Core's `/testing` sub-path gets its own report.
- **What it reads.** It analyses the built declarations only, with a minimal `overrideTsconfig`. api-extractor bundles TypeScript 5.9, and the declarations it reads come from the 6.0 API (`toolchain.md`), so the script silences the version notice.
- **Messages turned off:**
  - `ae-missing-release-tag`: Olas has no release stages.
  - `ae-undocumented`: TSDoc coverage is a BACKLOG item. Overloaded hooks carry their docs on the overloads, and this rule misses them.
  - `ae-wrong-input-file-type`: eslint's own `.cts` types are read for references, not analysed.
  - `ae-forgotten-export` on sub-paths: `/testing` names core's types through the shared chunk.
- **What fails.** A forgotten export on a main entry fails the run, alongside `check:public-types`.
- **Counting problems.** The script counts the warnings it prints, because `result.warningCount` also includes the notices it silenced.
- **Line endings.** `newlineKind: 'lf'` matches the `.gitattributes` checkout on every platform.
- **Doc models.** They are written for main entries only, because api-documenter keys models by package name, and `/testing` shares core's.

## Two fixes the site needed

- **Vue templates.** VitePress compiles every page as a Vue template, so `{{ … }}` in inline code, such as JSX's `options={{ deps }}`, broke the build. The config marks every inline code span `v-pre`, as VitePress already does for fenced blocks.
- **Dead links.** The dead-link check stays on. Only the reference's member links are exempt (`ignoreDeadLinks` in the config), because api-documenter writes them and every one exists.

## Why deploying is manual

`.github/workflows/docs.yml` builds the site on every pull request. It deploys to GitHub Pages only when someone runs it by hand with `deploy` ticked. Publishing a site is outward-facing, so it does not happen by merge. The site is served under `/olas/` (`base` in the config).

## Where the site is served from today

The site went live on 2026-09-25 at https://kontsedal.github.io/olas/, from the `gh-pages` branch ("Deploy from a branch"). The Actions route could not work yet: GitHub dispatches only a workflow that exists on the default branch, `docs.yml` is only on `release/1.0`, and the `github-pages` environment lets only `main` deploy. `gh-pages` holds the output of `pnpm docs:build` plus a `.nojekyll`. BACKLOG has the switch back to the Actions deploy once `docs.yml` reaches `main`.
