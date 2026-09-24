/**
 * Compile-time build flag. tsdown's `define:` inlines it: `false` in `dist/`,
 * the default export condition, and `true` in `dist/dev/`, behind the
 * `development` condition. Dead-code elimination drops every `if (__DEV__)`
 * branch from the default build. Under vitest the root `vitest.config.ts`
 * substitutes `true`. Mirrors `@kontsedal/olas-core`; SPEC §23.
 */
declare const __DEV__: boolean
