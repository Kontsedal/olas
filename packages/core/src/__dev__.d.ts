/**
 * Compile-time build flag. Substituted by tsdown's `define:` at bundle time
 * — `JSON.stringify(process.env.NODE_ENV !== 'production')`. The published
 * production `.mjs`/`.cjs` artefacts inline `false` here and the bundler's
 * dead-code elimination drops the wrapped emit sites entirely. Under vitest
 * the root `vitest.config.ts` substitutes `true`. See SPEC §23.x.
 */
declare const __DEV__: boolean
