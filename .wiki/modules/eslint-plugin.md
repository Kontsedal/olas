---
name: eslint-plugin
description: "@kontsedal/olas-eslint-plugin — six syntax-only rules for mistakes the types cannot see, the recommended and strict configs, and the example-app check that keeps them free of false positives."
type: module
covers:
  - packages/eslint-plugin/src/index.ts
  - packages/eslint-plugin/src/utils.ts
  - packages/eslint-plugin/src/rules/cancel-before-optimistic.ts
  - packages/eslint-plugin/src/rules/define-at-module-scope.ts
  - packages/eslint-plugin/src/rules/no-async-controller-factory.ts
  - packages/eslint-plugin/src/rules/no-network-in-components.ts
  - packages/eslint-plugin/src/rules/no-react-hooks-in-controllers.ts
  - packages/eslint-plugin/src/rules/optimistic-returns-snapshot.ts
edges:
  - { type: tested-by, target: ../../packages/eslint-plugin/tests/rules.test.ts }
  - { type: tested-by, target: ../../packages/eslint-plugin/tests/examples.test.ts }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
  - { type: related, target: ../decisions/canonical-vs-optimistic-writes.md }
last_verified: 2026-09-24
confidence: medium
---

# `@kontsedal/olas-eslint-plugin`

Six rules, each for a mistake the type system cannot see. They read syntax only: no rule asks for type information, so the plugin works with any parser and costs no type-aware lint setup. Each rule's page is in `packages/eslint-plugin/docs/`, and `createRule` in `utils.ts` points `meta.docs.url` there.

## The rules

| Rule | recommended | Matches on |
|---|---|---|
| `no-react-hooks-in-controllers` | error | a call named `use[A-Z0-9]…` inside the first argument of a `defineController` call |
| `define-at-module-scope` | error | `defineQuery` / `defineInfiniteQuery` / `defineMutation` / `defineScope` with an enclosing function |
| `no-async-controller-factory` | error | an `async` function as `defineController`'s first argument |
| `optimistic-returns-snapshot` | error | a `setData(…, fn)` method call whose result is discarded; `dropped` inside an `onMutate`, `outside` elsewhere |
| `cancel-before-optimistic` | warn | a `setData` in an `onMutate` with no `<same receiver>.cancel(…)` textually before it |
| `no-network-in-components` | off (strict: error) | `fetch` / `axios` inside a function whose name starts with a capital |

**What counts as an Olas `setData`.** A method call whose last argument is a function (`isOlasSetData`). That excludes `DataTransfer.setData(format, data)` and a bare `setData(...)` from a `useState` pair.

**What counts as the hook.** A function that is the value of an `onMutate` property. So does a function whose bound name is used as an `onMutate` value somewhere in the file, as in `onMutate: applyOptimistic`.

**Receivers are compared as source text.** `todos.cancel()` covers `todos.setData(…)`, and `this.q.cancel()` covers `this.q.setData(…)`. A cancel on another query does not count, and neither does one after the write.

## Two scoping decisions

**`define-at-module-scope` checks four definers, not six.** The first draft also checked `defineController` and `definePlugin`. Run over the example apps, it flagged `createAppRoot` functions that build a root controller around their arguments, which is the documented composition pattern. `definePlugin` inside a function is how a plugin takes options (`crossTabPlugin(options)`), and it would have flagged every such factory. Neither definition is looked up by identity. Queries, mutations and scopes are: by id in the root, by id in the mutation registry, and by object in `inject`.

**`optimistic-returns-snapshot` reports a discarded snapshot, not every `setData` outside `onMutate`.** The first draft flagged any `setData` outside a hook. A snapshot the code keeps, returns or settles on the spot is managed on purpose, and `setData(…).finalize()` is the only canonical patch a `LocalCache` has, because it has no `write`. The bug is the snapshot nothing holds.

## The example-app check

`tests/examples.test.ts` lints `examples/*/src/**/*.{ts,tsx}` with `recommended` through the ESLint API and expects no findings at all, warnings included. The examples are the idiomatic reference, so a finding is a rule bug or an example bug, and either one is worth a look. The first run found:
- three `cancel-before-optimistic` warnings in kanban's board controller: `moveCard`, `reorderColumn` and `archiveCard`, the `no-invalidator-still-refetches` pitfall;
- a leaked snapshot in reader-ssr's composer: `comments.setData(…)` after the server accepted a comment, left `hasPendingMutations` true after every post;
- an outdated workaround in kanban's archive, `setData(…).finalize()` from before infinite queries had `write`;
- the two `define-at-module-scope` false positives above.

Each example bug has a regression test confirmed to fail on the old code. Kanban's is in `examples/kanban/tests/board.test.ts`: "a board fetch in flight when a move starts cannot land over the move". Reader-ssr's is in `examples/reader-ssr/tests/controller.test.ts`: "the posted comment lands in the cache, and no snapshot is left pending".

## ESLint 10 and types

- `Program.parent` is `null` in ESLint 10 and `undefined` before. Every walk up the tree stops at `!= null` (`utils.ts`).
- The plugin's public type is `OlasEslintPlugin`: ESLint's own `ESLint.Plugin` with `configs` typed as `Linter.Config`. Typed with `@typescript-eslint/utils`' `FlatConfig` instead, the configs did not fit `Linter.Config[]` or `defineConfig`. `tests/config.test-d.ts` pins that they do. The rule modules are cast once, at the plugin boundary.
