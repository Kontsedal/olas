---
"@kontsedal/olas-eslint-plugin": minor
---

**Two new rules: `no-testing-outside-tests` and `honor-abort-signal`.** The plugin now has eight.

- `no-testing-outside-tests` reports an import of `@kontsedal/olas-core/testing` from a file that is not a test. From app code, those helpers ship to users, and a mock plugin or a mutation-registry teardown changes what the app does. The `testFiles` option lists the globs that count as tests, and it defaults to `**/*.test.*`, `**/*.spec.*`, `**/*.test-d.*`, `**/tests/**`, `**/test/**` and `**/__tests__/**`. An `import type` passes, because the build erases it. The rule is an error in `recommended` and in `strict`.
- `honor-abort-signal` reports a `fetcher` or `mutate` that does not read the `signal` from its context: a query's or a `createCache` fetcher, a `defineMutation`'s `mutate`, and an inline `createMutation` spec's `mutate`. Without the signal, a cancelled request runs to the end. The engine still drops its result, so the cost is the request, not wrong state. Passing the whole context to a helper counts as a use. A context named with a leading underscore, such as `_ctx`, marks work with nothing to abort, and the `ignorePattern` option changes that convention. The rule is an error in `strict` and off in `recommended`, because it cannot tell a request from local work such as a test fixture.
