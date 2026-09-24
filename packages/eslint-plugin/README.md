# @kontsedal/olas-eslint-plugin

ESLint rules for [Olas](../..) apps. Each rule catches a mistake the types cannot see. The mistakes are a React hook in a controller factory, a definition that loses its identity, an `async` factory, and an optimistic write whose snapshot no code settles.

## Install

```bash
pnpm add -D @kontsedal/olas-eslint-plugin eslint
```

`eslint >= 9` is a peer dependency, and the plugin uses flat config. The rules read syntax only, so they need no type information. TypeScript files still need a parser, such as the one `typescript-eslint` sets up.

## Setup

```js
// eslint.config.js
import olas from '@kontsedal/olas-eslint-plugin'
import tseslint from 'typescript-eslint'

export default [...tseslint.configs.recommended, olas.configs.recommended]
```

`olas.configs.strict` adds the opt-in rule and raises `cancel-before-optimistic` to an error.

## Rules

| Rule | `recommended` | `strict` | Catches |
|---|---|---|---|
| [`no-react-hooks-in-controllers`](docs/no-react-hooks-in-controllers.md) | error | error | A React hook inside a `defineController` factory. |
| [`define-at-module-scope`](docs/define-at-module-scope.md) | error | error | `defineQuery`, `defineInfiniteQuery`, `defineMutation` or `defineScope` inside a function. |
| [`no-async-controller-factory`](docs/no-async-controller-factory.md) | error | error | An `async` factory, which makes the controller's api a promise. |
| [`optimistic-returns-snapshot`](docs/optimistic-returns-snapshot.md) | error | error | A `setData` snapshot that `onMutate` does not return, or that other code discards. |
| [`cancel-before-optimistic`](docs/cancel-before-optimistic.md) | warn | error | An optimistic `setData` in `onMutate` with no `cancel` on the same query before it. |
| [`no-network-in-components`](docs/no-network-in-components.md) | off | error | `fetch` or `axios` inside a React component. |

## How it is checked

- `tests/rules.test.ts` runs every rule through `@typescript-eslint/rule-tester`, with valid and invalid cases.
- `tests/examples.test.ts` runs `recommended` over the source of every example app in this repo and expects no findings. The first run found four real mistakes in the examples: three optimistic writes with no `cancel` first, and one leaked snapshot. It also found two false positives in `define-at-module-scope`. All six are fixed.
