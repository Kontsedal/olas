---
name: docs-site
description: The VitePress docs site and the api-extractor reports — why the site syncs the repo docs instead of owning copies, how the reference is generated, what the theme changes and why, what CI checks, and why deploying is manual.
type: decision
covers:
  - docs/.vitepress/config.mts
  - docs/.vitepress/theme/index.ts
  - docs/.vitepress/theme/style.css
  - docs/.vitepress/theme/framework.ts
  - docs/.vitepress/theme/components/HomeHero.vue
  - docs/.vitepress/theme/components/TwoTrees.vue
  - docs/.vitepress/theme/components/FrameworkPicker.vue
  - docs/.vitepress/theme/components/ForFramework.vue
  - docs/index.md
  - scripts/docs-sync.mjs
  - scripts/api-report.mjs
  - .github/workflows/docs.yml
  - .github/workflows/ci.yml
edges:
  - { type: related, target: typechecked-doc-snippets.md }
  - { type: related, target: esm-only-build.md }
  - { type: related, target: toolchain.md }
  - { type: related, target: ui-rules.md }
last_verified: 2026-09-25
confidence: medium
---

# The docs site and the API reports

## The decision

The site is VitePress, in `docs/`. It has three kinds of page:

| Kind | Where it comes from | In git |
|---|---|---|
| Guides | written in `docs/guide/` (what-is-olas, getting-started, concepts, queries, mutations, forms, ssr, testing, performance) and `docs/index.md` | yes |
| Synced pages | `scripts/docs-sync.mjs` copies RECIPES, PLUGINS, MIGRATING and every package README into `docs/guide/`, `docs/adapters/` and `docs/packages/` | no |
| Reference | `api-documenter` renders the doc model that api-extractor writes, into `docs/reference/` | no |

Each published entry point also has an API report, `packages/*/etc/*.api.md`, checked in. `pnpm api:check` (`scripts/api-report.mjs`, in CI after `check:public-types`) fails when a report no longer matches the built `.d.ts`. `pnpm api:update` rewrites them.

## Why sync instead of moving the docs

The repo docs are what npm and GitHub readers see. `pnpm check:doc-snippets` keeps their code compiling (`typechecked-doc-snippets.md`). Moving them into `docs/` would split the audience, and copying them would drift. So the site reads them at build time, and each fact has one source.

The sync rewrites relative links, because a link written for `packages/react/README.md` is wrong on `/adapters/react` (`scripts/docs-sync.mjs`, `rewriteLink`). A link to another synced doc becomes that page's route. Any other link points at the file on GitHub. Code blocks are set aside first, so a link-shaped string in code stays as written. The guides themselves are checked by the snippet checker, which skips the synced copies.

API.md stays. The plan named the generated reference as a replacement for its reference sections, but API.md carries checked examples, gotchas and prose that api-documenter cannot produce. The two now sit side by side: API.md is the narrative reference, and `/reference/` has every export's exact signature.

## The reference pages

`scripts/docs-sync.mjs` edits api-documenter's output in three ways:

- **The title.** api-documenter opens each page with an H2, such as `createRoot() function`. The sync makes it the H1, so VitePress takes the tab title from it and the page gets the guide's title style.
- **The breadcrumb.** The first crumb reads "API reference" instead of "Home", because it links to the reference index. Each page gets `pageClass: api-page`, which the theme uses to set the breadcrumb small and quiet.
- **The index.** api-documenter's own index listed the packages under an empty description column, because no package has a TSDoc package comment. The sync writes the index from each `package.json` `description`, so npm and the site describe a package in the same words.

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

## The theme

`docs/.vitepress/theme/` extends the default theme. The goal was a site that reads as Olas rather than as stock VitePress, and a shorter path for a new reader. It changes five things.

- **Palette.** The site takes the house palette from `examples/_shared/ui/tokens.css`: sea teal at hue 196 and cool neutrals at hue 240, which the devtools panel carries too (`ui-rules.md`). `style.css` writes the values in hex, because VitePress mixes some of them with alpha. The accent marks a link, the current page and the primary button. Inline code is ink on a grey wash, so the accent keeps that one meaning. VitePress reads its "indigo" slot for the brand and its "purple" slot for `important` callouts. The theme points the first at the teal and the second at the info blue, so no violet is left.
- **Type.** The site sets prose in Atkinson Hyperlegible Next and code in Atkinson Hyperlegible Mono. The fonts come from the `@fontsource-variable` packages in the root devDependencies. The site serves them itself and requests no font from another host. The Braille Institute drew the family so that `l`, `I` and `1` differ, and `O` and `0` differ, which suits pages full of identifiers. It has two costs. Its zero is slashed in prose as well as in code, and the font has no alternate glyph. Its mono is wider than most, about 0.63em a character, so a code line longer than about 72 characters scrolls on a guide page.
- **The home page.** `HomeHero.vue` replaces the default hero through the `home-hero-before` slot, so `index.md` has no `hero` frontmatter. The hero's figure is `TwoTrees.vue`, the two-trees diagram that also opens Concepts and What is Olas. The rows line up across its three columns, and the headers share one grid row, so a header that wraps on a phone moves both trees together. The rest of the home page is Markdown in `index.md`, so its code is highlighted at build time and checked by `pnpm check:doc-snippets`.
- **The framework picker.** `<FrameworkPicker />` and `<ForFramework name="react">` show one framework's code, on the home page and in Getting started. One `ref` in `framework.ts` holds the choice for the whole site, and `localStorage` keeps it across visits. The server renders React and the saved choice is read after mount, so the first client render matches the server HTML. `ForFramework` uses `v-show`, so every framework stays in the HTML for search and for readers without JavaScript. The snippet checker scans fences line by line, so it still checks every block inside a `ForFramework`. Put headings outside one, or the page outline lists each framework's copy.
- **Navigation.** The nav has four items: Guide, Packages, API and a `1.0` menu. The guide and the adapter pages share one sidebar, ordered the way a new reader meets the library: Introduction, Essentials, Your framework, Going further, Upgrading. The packages sidebar groups them by job.

Two things bit during the work:

- **A bare `display: grid` widens the page.** A single implicit column sizes to its widest child's min-content, so one long code line pushed the home page past a phone's width. Every home grid starts as `grid-template-columns: minmax(0, 1fr)`.
- **Headless Chrome cannot screenshot a phone.** Chrome keeps a window at least about 500px wide. With `--window-size=390,…` it lays the page out at 500px and crops the image, which looks like an overflow that is not there. A narrow check needs viewport emulation, such as puppeteer's `setViewport({ width: 390 })`. Comparing `document.documentElement.scrollWidth` with `clientWidth` gives the overflow as a number.

## Why deploying is manual

`.github/workflows/docs.yml` builds the site on every pull request. It deploys to GitHub Pages only when someone runs it by hand with `deploy` ticked. Publishing a site is outward-facing, so it does not happen by merge. The site is served under `/olas/` (`base` in the config).

## Where the site is served from today

The site went live on 2026-09-25 at https://kontsedal.github.io/olas/, from the `gh-pages` branch ("Deploy from a branch"). The Actions route could not work yet: GitHub dispatches only a workflow that exists on the default branch, `docs.yml` is only on `release/1.0`, and the `github-pages` environment lets only `main` deploy. `gh-pages` holds the output of `pnpm docs:build` plus a `.nojekyll`. BACKLOG has the switch back to the Actions deploy once `docs.yml` reaches `main`.
