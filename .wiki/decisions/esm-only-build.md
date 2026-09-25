---
name: esm-only-build
description: Why every package ships ESM only on Node >= 20.19, and what guards the published dist (types, tree-shaking, size).
type: decision
covers:
  - packages/core/tsdown.config.ts
  - packages/core/package.json
  - packages/core/src/query/mutation-registry.ts
  - tsconfig.base.json
  - scripts/verify-dist.mjs
  - scripts/check-public-types.ts
  - .size-limit.json
  - .github/workflows/ci.yml
edges:
  - { type: related, target: brand-markers-not-classes.md }
  - { type: related, target: ctx-primitives-are-free-functions.md }
last_verified: 2026-09-25
confidence: medium
---

# ESM only, Node >= 20.19

## The decision

Every published package builds one format. `tsdown` runs with `format: ['esm']` and writes `dist/*.js` and `dist/*.d.ts`. Each `exports` entry is `{ types, default }`, and `engines.node` is `>=20.19`. The top-level `types` field stays, for TypeScript configs that still resolve with `node10`.

## Why

- **`require()` of ESM works on every supported Node.** Node 20.19 and 22.12 load an ES module through `require()`, as long as it has no top-level await. A CommonJS consumer still works without a CJS build.
- **The dual-package hazard goes away.** With both builds, a graph could load the ESM copy and the CJS copy of core side by side. The module-level registries lived on `globalThis` under `Symbol.for` keys to survive that. With one format there is one module instance, so the mutation registry is a plain module-level `Map` (`packages/core/src/query/mutation-registry.ts`).
- **Half the declaration files.** `.d.mts` and `.d.cts` were two copies of every type, and the top-level `types` pointed at the CJS one.

The brands stay `Symbol.for` keys. Two different *versions* of core can still meet in one bundle, and the brands are how they recognize each other's values.

## What guards the dist

All of these run in CI after `pnpm build`:

- **`attw --profile esm-only`.** Type resolution for `node16` from ESM and for `bundler`. The CJS and `node10` rows are ignored on purpose.
- **`publint`.** The packaging metadata.
- **`pnpm smoke:dist`** (`scripts/verify-dist.mjs`). Each entry imports and loads through `require()`. No `__DEV__` literal is left in code. A controllers-only bundle built from core's dist carries neither forms (`olas.form`) nor the query engine (`QueryClient = class`), and a positive control proves the check sees both when they are imported. Every `development` export condition points at a build that loads and exports the same names, and core's production build emits no devtools events while its development build does. A separate CI job runs this smoke on Node 20.19, 22 and 24.
- **`pnpm check:public-types`** (`scripts/check-public-types.ts`). It walks each entry's `.d.ts` from every export, following type references. A type that a public signature names but no entry exports fails the check.
- **`pnpm size`** (`.size-limit.json`). A brotli budget per entry, about 5% over the measured size, so a regression fails and noise doesn't.

`stripInternal` is on in `tsconfig.base.json`, and `tsdown`'s declaration build honours it. Tagging a member `@internal` removes it and everything only it reaches from the `.d.ts`: `Ctx`'s `[CTX_INTERNALS]` took `CtxInternals` and the whole `QueryClient` class with it. The chunk shrank from 2,493 lines to 1,716.

## Two builds per package: production and development

Core, cross-tab, entities, mutation-queue, persist, react, vue and zod have `if (__DEV__)` branches. Cross-tab and mutation-queue joined them in 1.0 when each gained a devtools lane (`../modules/cross-tab.md`, `../modules/mutation-queue.md`), and vue for its missing-effect-scope warning. Each ships two builds from one source (its `tsdown.config.ts` exports an array): `dist/` with `__DEV__: 'false'`, and `dist/dev/` with `__DEV__: 'true'`. The exports map puts the dev build behind a `development` condition, between `types` and `default`. tsdown cleans once for both configs before either builds, so they cannot wipe each other.

Before 1.0, `__DEV__` came from `NODE_ENV` at build time, and the release build ran with `NODE_ENV=production`. So the published core had no devtools events at all, and `@kontsedal/olas-devtools` showed an empty tree against it, in 0.8 too. Two fixes were weighed:
- **An unguarded `process.env.NODE_ENV` left in the dist,** as React and Redux do. It throws `process is not defined` in a browser with no bundler. A `typeof process` guard avoids that, but it also defeats Vite's dev server: Vite replaces `process.env.NODE_ENV`, not `typeof process`, so the guard reads `false` in the browser.
- **A `development` export condition,** which was chosen. The default build stays production, so nothing can crash without a bundler.

How it resolves, checked on 2026-09-25:
- Vite 8's dev server resolves `dist/dev/index.js`, and `vite build` resolves `dist/index.js`. Vite picks the condition from `NODE_ENV`, which `vite build` sets to `production`.
- Node resolves the dev build under `--conditions=development` only.
- webpack, Rspack and Next pick `development` in development mode, by their documentation.
- esbuild and Rollup need `conditions: ['development']`.

The size budgets measure the default build, so they did not move.

## The forms retention fix

A bundle built from `dist` used to keep all of forms even when nothing imported them: 8.62 KB gzipped for controllers only, against 4.8 KB from `src`. `tsdown` emits one shared chunk, so exclusion rests on statement-level dead-code elimination. esbuild keeps a class that has a computed class-field key (`readonly [FORM_BRAND] = true`) even when the class is unused. The brands are now set in the constructors (`packages/core/src/forms/form.ts`), and the same bundle is 6.35 KB gzipped, the same as from `src`. The rest is `createRoot`'s own code, including the plugin host it always builds. The smoke check above pins this; a negative test reintroducing the class field made it fail.

Measured at the time of the change (brotli, `size-limit`): controllers + signals 5.21 kB, + forms 8.96 kB, + queries and mutations 14.95 kB, everything 20.34 kB. W10 (infinite-query parity) grew the last two to 15.84 kB and 21.23 kB, and their budgets were raised with it. The 1.0 query-engine backlog pass took the four to 5.26, 9.17, 16.68 and 22.41 kB, from 5.16, 9.08, 16.18 and 21.84 kB at `e4c1a09`. It added the catch-up refetch, the throwing-retry fix, `LocalCache.write` and `replace`, local caches in `waitForIdle` and the subscriber events. The last two budgets were raised to 17.5 KB and 23.5 KB, about 5% over. In the same pass, the entities backprop rebuild (`../modules/entities.md`) grew entities from 2.2 kB to 2.27 kB, and its budget went from 2.2 KB to 2.4 KB.
