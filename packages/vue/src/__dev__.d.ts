/**
 * Compile-time build flag, substituted by tsdown's `define:`. The default
 * build (`dist/`) inlines `false`, and the bundler drops every
 * `if (__DEV__)` branch. The `development` build (`dist/dev/`) inlines
 * `true`. Under vitest the root `vitest.config.ts` substitutes `true`.
 * See SPEC §23.
 */
declare const __DEV__: boolean
