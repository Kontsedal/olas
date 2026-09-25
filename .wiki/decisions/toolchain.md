---
name: toolchain
description: The dev toolchain after the 2026-09-25 upgrade — TypeScript 7 beside the 6.0 API, the Node floor for building versus the Node floor for consumers, pnpm 12's install policies, and the vitest 5 migration.
type: decision
covers:
  - package.json
  - pnpm-workspace.yaml
  - examples/vue-tasks/package.json
  - .github/workflows/ci.yml
  - .github/workflows/publish.yml
  - packages/core/bench/engine.bench.ts
  - packages/core/bench/baselines.bench.ts
  - packages/devtools/scripts/minify-css.ts
edges:
  - { type: related, target: esm-only-build.md }
  - { type: related, target: docs-site.md }
  - { type: related, target: peer-bump-guard.md }
  - { type: related, target: benchmarks.md }
  - { type: related, target: ../pitfalls/dts-export-context.md }
  - { type: documented-in, target: ../../CLAUDE.md }
last_verified: 2026-09-25
confidence: medium
---

# The dev toolchain

On 2026-09-25 every dependency moved to its latest version. This page records the choices that upgrade forced, so the next one does not re-derive them.

## Two TypeScripts

TypeScript 7 is the native compiler, and 7.0 ships no JavaScript API. Five things here call that API through `require('typescript')`:
- typescript-eslint, under `packages/eslint-plugin`'s tests.
- svelte-check, in `packages/svelte`'s `typecheck`.
- vue-tsc, in `examples/vue-tasks`'s `typecheck`.
- rolldown-plugin-dts, which tsdown uses to emit every published `.d.ts`.
- `scripts/check-doc-snippets.ts`.

So the root `package.json` installs both, in the layout the TypeScript 7 announcement gives:

```json
"@typescript/native": "npm:typescript@^7.0.2",
"typescript": "npm:@typescript/typescript6@^6.0.2"
```

- **`tsc` is TypeScript 7.** `@typescript/native` links the `tsc` binary, and every `typecheck` script runs it.
- **`typescript` is the 6.0 API.** `@typescript/typescript6` re-exports `typescript@6` and links only `tsc6`, so the two binaries do not collide.
- **The published declarations come from 6.0.** rolldown-plugin-dts reads the `typescript` package. Its experimental `generator: 'tsgo'` would use TypeScript 7, but 7.0.2 still has two `.d.ts` emit bugs that 7.1 fixes.
- **api-extractor bundles its own TypeScript 5.9** and only reads the built `.d.ts` (`docs-site.md`).
- **`examples/vue-tasks` has both too**, because vue-tsc needs the 6.0 API. The other examples run only `tsc`, so they depend on `typescript@^7` directly.

Do not collapse the pair into one `typescript@7`: `pnpm install` then reports unmet peers for typescript-eslint and svelte-check, and both fail at runtime.

## Node: 22.22 to build, 20.19 to consume

The published packages keep `engines.node >= 20.19` (`esm-only-build.md`). The toolchain needs more:

| Tool | Node |
|---|---|
| jsdom 30 | `^22.22.2 \|\| ^24.15.0 \|\| >=26` |
| tsdown 0.23, rolldown-plugin-dts 0.28 | `^22.18 \|\| ^24.11 \|\| >=26` |
| vitest 5 | `^22.12 \|\| ^24 \|\| >=26` |
| changesets 3 | `^22.11 \|\| ^24 \|\| >=26` |

Every workflow installs and builds on Node 22, and the root `engines.node` is jsdom's range, the strictest one. The `dist-on-node` job in `ci.yml` builds on 22 and then switches to the matrix Node. There it runs `node scripts/verify-dist.mjs` alone, so the 20.19 leg still proves that the dist loads on 20.19.

## pnpm 12

pnpm 12 is a native rewrite of pnpm 11, and it keeps 11's settings. Four of them changed how this repo installs.

- **`.npmrc` holds auth only.** Every other setting lives in `pnpm-workspace.yaml`. The repo's `.npmrc` is gitignored and holds a token, so nothing moved.
- **A build script needs a decision.** pnpm 11+ fails an install on a dependency build script that no one allowed or denied. `pnpm-workspace.yaml` sets `allowBuilds: { esbuild: false }`: esbuild's postinstall only re-checks the binary its optional dependency installed.
- **Registry auth comes from `~/.npmrc` or the project `.npmrc`.** pnpm ignores the `NPM_CONFIG_USERCONFIG` file that setup-node's `registry-url` writes. `publish.yml` writes the token to `~/.npmrc` in the step before publishing. A local run with a fake token in a temporary home got a 401 from `pnpm whoami`, so pnpm 12 does send it.
- **`minimumReleaseAge` defaults to one day.** pnpm refuses a lockfile that holds a version published less than 24 hours ago, and suggests `pnpm clean --lockfile`. On 2026-09-25 that held vitest and `@vitest/coverage-v8` at 5.0.1 and size-limit at 14.0.0. The repo keeps the default, because the delay is what catches a compromised release before it installs.

Pinning pnpm 12 in `packageManager` makes `pnpm-lock.yaml` two YAML documents. The first records the pinned pnpm itself. CI installs pnpm through `pnpm/action-setup@v6.1.0`, pinned to the patch because its floating `v6` tag still points at 6.0.10, which predates pnpm 12.

## vitest 5

- **`bench` is a test fixture.** It is no longer an export of `vitest`. Each bench file's old `describe` group is now a `test` that builds its fixture, runs `bench(...).run()` or `bench.compare(...)`, and tears the fixture down. Iteration counts moved from the per-bench options to the run options, where tinybench 6 reads them.
- **vitest 5 warns about module-runner getters in the benchmarks.** The warning is new, but the overhead is not. The bench files import `../src`, and vitest 4 loaded source through the same module runner. BACKLOG has the fix.
- **`clearMocks` defaults to `true`**, and an unawaited async assertion fails its test. The suite passed unchanged under both.
- **Reports go to `.vitest/`**, which `.gitignore` lists.

## Smaller migrations

- **The root package is `"type": "module"`.** Vite 8.3 warns about a config file that its future native loader cannot load. Two shapes trip it: ESM syntax in a file Node treats as CommonJS, and a relative import without an extension. The root configs use `import.meta.dirname` instead of `__dirname`, and the example configs import `../_shared/aliases.ts` with its extension.
- **biome 2.5** renamed `linter.rules.recommended` to `preset` (`biome migrate`). It added `noUnsafeOptionalChaining`, `noProto` and `noSvgWithoutTitle` to the recommended set, and it now lints `.svg` files. Twelve test casts became `(x?.y as T | undefined)?.z`, so a missing value fails the assertion instead of throwing. The one deliberate `__proto__` test carries a range suppression.
- **rolldown 1.2 warns on a transform without a sourcemap.** `packages/devtools/scripts/minify-css.ts` now returns a `magic-string` map for the stylesheet it minifies.
- **rolldown-plugin-dts 0.28 writes exports inline**, which leaked two private symbols from entities' declarations (`../pitfalls/dts-export-context.md`). The new emit also moved union bars and mapped-type semicolons, so four API reports were regenerated with no change in meaning.
- **VitePress needs `vue` at the root.** Its SSR build resolves each page's compiled `vue/server-renderer` import from the repo root. The pnpm 10 install resolved it without a root `vue`; the pnpm 12 install does not, so the root declares `vue`.
