---
"@kontsedal/olas-eslint-plugin": major
---

**New: `@kontsedal/olas-eslint-plugin`.** Six rules for mistakes the types cannot see, with `recommended` and `strict` flat configs.

- `no-react-hooks-in-controllers`: a React hook inside a `defineController` factory, which runs outside any render.
- `define-at-module-scope`: `defineQuery`, `defineInfiniteQuery`, `defineMutation` or `defineScope` inside a function, where each call makes a new identity.
- `no-async-controller-factory`: an `async` factory, which makes the controller's api a promise.
- `optimistic-returns-snapshot`: a `setData` snapshot that `onMutate` does not return, or that other code discards, so nothing settles it.
- `cancel-before-optimistic`: an optimistic `setData` in `onMutate` with no `cancel` on the same query first, so a fetch in flight can land over it. A warning in `recommended`, an error in `strict`.
- `no-network-in-components`: `fetch` or `axios` inside a React component. Opt-in, on in `strict`.

The rules read syntax only, so they need no type information. The configs are typed with ESLint's own `Linter.Config`, so a typed `eslint.config.ts` accepts them as they are. Requires ESLint 9 or later.
