/**
 * Compile-time build flag. `tsdown.config.ts` inlines it per build: `false`
 * in `dist/` (the default export condition), where dead-code elimination
 * drops every `if (__DEV__)` branch, and `true` in `dist/dev/` (the
 * `development` condition). Under vitest the root `vitest.config.ts`
 * substitutes `true`. See SPEC §23.
 */
declare const __DEV__: boolean
