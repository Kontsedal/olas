---
"@kontsedal/olas-core": minor
"@kontsedal/olas-entities": minor
"@kontsedal/olas-persist": minor
"@kontsedal/olas-react": minor
"@kontsedal/olas-zod": minor
---

**A development build behind a `development` export condition.** Devtools now work against the published packages.

Until now, the release build inlined `__DEV__ = false`, so the core on npm emitted no devtools events at all. `@kontsedal/olas-devtools` showed an empty controller tree and timeline against it, and the dev-only warnings in core, entities, persist, react and zod never fired in an app.

Each of these packages now ships two builds:
- `dist/` is the default, a production build with every dev-only branch stripped;
- `dist/dev/` sits behind the `development` condition, with the devtools events and the dev warnings kept.

Vite's dev server, webpack and Rspack in development mode, and Next.js in dev resolve `development` without configuration, and their production builds resolve the default. With esbuild or Rollup, add `conditions: ['development']` to the dev config; in Node, `--conditions=development`. A browser with no bundler, or a CDN, gets the default build, as before.

The production build is unchanged, and so are the bundle sizes. SPEC §23 has the details.
