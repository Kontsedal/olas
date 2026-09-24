---
name: eslint-plugin
description: "@kontsedal/olas-eslint-plugin — eight syntax-only rules for mistakes the types cannot see, the recommended and strict configs, and the example-app check that keeps them free of false positives."
type: module
covers:
  - packages/eslint-plugin/src/index.ts
  - packages/eslint-plugin/src/utils.ts
  - packages/eslint-plugin/src/rules/cancel-before-optimistic.ts
  - packages/eslint-plugin/src/rules/define-at-module-scope.ts
  - packages/eslint-plugin/src/rules/honor-abort-signal.ts
  - packages/eslint-plugin/src/rules/no-async-controller-factory.ts
  - packages/eslint-plugin/src/rules/no-network-in-components.ts
  - packages/eslint-plugin/src/rules/no-react-hooks-in-controllers.ts
  - packages/eslint-plugin/src/rules/no-testing-outside-tests.ts
  - packages/eslint-plugin/src/rules/optimistic-returns-snapshot.ts
edges:
  - { type: tested-by, target: ../../packages/eslint-plugin/tests/rules.test.ts }
  - { type: tested-by, target: ../../packages/eslint-plugin/tests/examples.test.ts }
  - { type: tested-by, target: ../../packages/eslint-plugin/tests/config.test-d.ts }
  - { type: related, target: ../pitfalls/no-invalidator-still-refetches.md }
  - { type: related, target: ../pitfalls/raceabort-for-misbehaving-mutate.md }
  - { type: related, target: ../decisions/canonical-vs-optimistic-writes.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-eslint-plugin`

Eight rules, each for a mistake the type system cannot see. They read syntax only: no rule asks for type information, so the plugin works with any parser and costs no type-aware lint setup. Each rule's page is in `packages/eslint-plugin/docs/`, and `createRule` in `utils.ts` points `meta.docs.url` there.

## The rules

| Rule | recommended | Matches on |
|---|---|---|
| `no-react-hooks-in-controllers` | error | a call named `use[A-Z0-9]…` inside the first argument of a `defineController` call |
| `define-at-module-scope` | error | `defineQuery` / `defineInfiniteQuery` / `defineMutation` / `defineScope` with an enclosing function |
| `no-async-controller-factory` | error | an `async` function as `defineController`'s first argument |
| `optimistic-returns-snapshot` | error | a `setData(…, fn)` method call whose result is discarded; `dropped` inside an `onMutate`, `outside` elsewhere |
| `cancel-before-optimistic` | warn | a `setData` in an `onMutate` with no `<same receiver>.cancel(…)` textually before it |
| `no-testing-outside-tests` | error | an import, `export … from`, `import()` or `require()` of `@kontsedal/olas-core/testing` in a file that matches none of `testFiles` |
| `no-network-in-components` | off (strict: error) | `fetch` / `axios` inside a function whose name starts with a capital |
| `honor-abort-signal` | off (strict: error) | a `fetcher` or `mutate` written in place whose context gives up no `signal` |

**What counts as an Olas `setData`.** A method call whose last argument is a function (`isOlasSetData`). That excludes `DataTransfer.setData(format, data)` and a bare `setData(...)` from a `useState` pair.

**What counts as the hook.** A function that is the value of an `onMutate` property. So does a function whose bound name is used as an `onMutate` value somewhere in the file, as in `onMutate: applyOptimistic`.

**Receivers are compared as source text.** `todos.cancel()` covers `todos.setData(…)`, and `this.q.cancel()` covers `this.q.setData(…)`. A cancel on another query does not count, and neither does one after the write.

## `honor-abort-signal`

**Where it looks** (`honor-abort-signal.ts:30-51`). The `fetcher` property of a `defineQuery` or `defineInfiniteQuery` object literal and `createCache`'s second argument take the context first. The `mutate` property of `defineMutation` and of an inline `createMutation(ctx, { … })` spec take it second. `createMutation(ctx, def, hooks)` passes a name, so its `mutate` is checked where `defineMutation` wrote it. A function passed by name is not followed.

**What counts as using the signal.** The rule uses the scope manager's references, and three findings follow (`honor-abort-signal.ts:102-175`):
- `missing`: no parameter at the context's position, and no read of `arguments`;
- `notTaken`: a pattern with no `signal` key and no rest, or an identifier whose reads are all `ctx.<other>`;
- `unused`: a `signal` binding with no read, including one from `const { signal } = ctx`.

**The escape hatch is any use of the whole context.** Syntax cannot see into a helper. So `helper(ctx)`, `{ ...ctx }`, `ctx[key]`, a copy into another name and a read rest parameter all pass. A computed pattern key passes too, because it could be `signal`. Only a member read of another name, such as `ctx.deps`, does not count. The `ignorePattern` option, `'^_'` by default, skips a context, a `signal` binding or a rest parameter whose name matches. That is how a fetcher with nothing to abort says so: `(_ctx) => db.get(…)`.

**Why only `strict`.** An ignored signal wastes the request, and the state stays right: `Entry` drops a superseded fetch through `currentFetchId`, and `mutate` is raced against its signal (`pitfalls/raceabort-for-misbehaving-mutate.md`). The rule also cannot tell a request from local work, and test fixtures like `fetcher: async () => user` are correct. `recommended` carries rules whose findings are bugs.

## `no-testing-outside-tests`

**The default test globs** (`no-testing-outside-tests.ts:7-14`) are `**/*.test.*`, `**/*.spec.*`, `**/*.test-d.*`, `**/tests/**`, `**/test/**` and `**/__tests__/**`. The BACKLOG entry named four; `*.test-d.*` is Vitest's type-test suffix and `test/` is the Node test runner's and Mocha's default directory. `testFiles` replaces the defaults instead of adding to them, because `createRule` merges options deeply but replaces an array whole.

**The path is relative to `context.cwd`** (`no-testing-outside-tests.ts:50-57`), so a repo checked out under a directory named `tests` does not make every file a test. A file outside `cwd` keeps its absolute path, and a `**/` glob still matches it. The prefix check ignores case, because Windows tools disagree on drive-letter case.

**The glob matcher is local** (`globToRegExp`, `no-testing-outside-tests.ts:21-47`). It supports `**`, `*`, `?` and `{a,b}`, and treats every other character as a literal. `minimatch` ships with ESLint, but it is ESLint's dependency, not the plugin's. Yarn Plug'n'Play refuses an undeclared import, and declaring it would add a package for four glob features.

**Type-only imports pass.** An `import type`, an `export type … from` and an `export type *` are erased at build time. An inline `type` specifier, as in `import { type X, y }`, does not pass, because the import stays in the output.

**Why `recommended`.** The rule reads a module name and a file path, so it cannot misread code. Its one false positive is a test-support file outside the default layout, and one glob or one `files` override fixes it.

## Two scoping decisions

**`define-at-module-scope` checks four definers, not six.** The first draft also checked `defineController` and `definePlugin`. Run over the example apps, it flagged `createAppRoot` functions that build a root controller around their arguments, which is the documented composition pattern. `definePlugin` inside a function is how a plugin takes options (`crossTabPlugin(options)`), and it would have flagged every such factory. Neither definition is looked up by identity. Queries, mutations and scopes are: by id in the root, by id in the mutation registry, and by object in `inject`.

**`optimistic-returns-snapshot` reports a discarded snapshot, not every `setData` outside `onMutate`.** The first draft flagged any `setData` outside a hook. A snapshot the code keeps, returns or settles on the spot is managed on purpose, and `setData(…).finalize()` is the only canonical patch a `LocalCache` has, because it has no `write`. The bug is the snapshot nothing holds.

## The example-app check

`tests/examples.test.ts` lints `examples/*/src/**` and `examples/*/tests/**` with `recommended` and again with `strict`, through the ESLint API. It expects no findings at all, warnings included. The examples are the idiomatic reference, so a finding is a rule bug or an example bug, and either one is worth a look. `strict` runs so the two opt-in rules get the same check. The tests are linted so `no-testing-outside-tests` has to pass the three example test files that import `/testing`.

The first run, with `recommended` over `src` only, found:
- three `cancel-before-optimistic` warnings in kanban's board controller: `moveCard`, `reorderColumn` and `archiveCard`, the `no-invalidator-still-refetches` pitfall;
- a leaked snapshot in reader-ssr's composer: `comments.setData(…)` after the server accepted a comment, left `hasPendingMutations` true after every post;
- an outdated workaround in kanban's archive, `setData(…).finalize()` from before infinite queries had `write`;
- the two `define-at-module-scope` false positives above.

Each example bug has a regression test confirmed to fail on the old code. Kanban's is in `examples/kanban/tests/board.test.ts`: "a board fetch in flight when a move starts cannot land over the move". Reader-ssr's is in `examples/reader-ssr/tests/controller.test.ts`: "the posted comment lands in the cache, and no snapshot is left pending".

`honor-abort-signal` and `no-testing-outside-tests` found nothing in the examples when they landed. Every example fetcher and `mutate` destructures `signal` and passes it on.

## ESLint 10 and types

- `Program.parent` is `null` in ESLint 10 and `undefined` before. Every walk up the tree stops at `!= null` (`utils.ts`).
- The plugin's public type is `OlasEslintPlugin`: ESLint's own `ESLint.Plugin` with `configs` typed as `Linter.Config`. Typed with `@typescript-eslint/utils`' `FlatConfig` instead, the configs did not fit `Linter.Config[]` or `defineConfig`. `tests/config.test-d.ts` pins that they do, with and without rule options. The rule modules are cast once, at the plugin boundary.
- The two rules with options type them on the rule module, so `rules['honor-abort-signal'].defaultOptions` is `[{ ignorePattern: string }]`. `createRule` fills an option the user leaves out from `defaultOptions`.
