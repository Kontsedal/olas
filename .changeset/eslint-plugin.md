---
"@kontsedal/olas-eslint-plugin": major
---

**New: `@kontsedal/olas-eslint-plugin`.** Eight rules for mistakes the types cannot see, with `recommended` and `strict` flat configs.

- `no-react-hooks-in-controllers`: a React hook inside a `defineController` factory, which runs outside any render.
- `define-at-module-scope`: `defineQuery`, `defineInfiniteQuery`, `defineMutation` or `defineScope` inside a function, where each call makes a new identity.
- `no-async-controller-factory`: an `async` factory, which makes the controller's api a promise.
- `optimistic-returns-snapshot`: a `setData` snapshot that `onMutate` does not return, or that other code discards, so nothing settles it.
- `cancel-before-optimistic`: an optimistic `setData` in `onMutate` with no `cancel` on the same query first, so a fetch in flight can land over it. A warning in `recommended`, an error in `strict`.
- `no-testing-outside-tests`: an import of `@kontsedal/olas-core/testing` from a file that is not a test, so test helpers such as a mock plugin would ship to users. The `testFiles` option lists the globs that count as tests. An error in both configs.
- `no-network-in-components`: `fetch` or `axios` inside a React component. Opt-in, on in `strict`.
- `honor-abort-signal`: a `fetcher` or `mutate` that never reads the `signal` from its context, so a cancelled request runs to the end. Passing the whole context to a helper counts as a use, and a context named `_ctx` opts out. On in `strict`, because it cannot tell a request from local work such as a test fixture.

The rules read syntax only, so they need no type information. The configs are typed with ESLint's own `Linter.Config`, so a typed `eslint.config.ts` accepts them as they are. Requires ESLint 9 or later.
