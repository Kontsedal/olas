# `olas/no-testing-outside-tests`

Reports an import of `@kontsedal/olas-core/testing` from a file that is not a test. In `recommended`, as an error.

## Why

`@kontsedal/olas-core/testing` holds the test helpers: `createTestController`, `createPluginRecorder`, `mockFetchPlugin` and a mutation-registry teardown. Core puts them on their own sub-path so an import of them is easy to find. Imported from app code, they ship to users, and a mock plugin or a registry teardown there changes what the app does.

The rule reads `import` and `export … from` declarations, `import(…)` and `require(…)`. An `import type` passes, because the build erases it. An inline `type` specifier, as in `import { type X, y }`, does not pass, because the import stays in the output.

## What counts as a test

A file counts as a test when its path, relative to ESLint's working directory, matches one of these globs:
- `**/*.test.*`, `**/*.spec.*` and `**/*.test-d.*`;
- `**/tests/**`, `**/test/**` and `**/__tests__/**`.

`*.test-d.*` is Vitest's suffix for type tests, and `test/` is the default directory for Node's test runner and Mocha. The globs support `**`, `*`, `?` and `{a,b}`, and a directory matches by whole name: `contests/` is not `tests/`.

## Options

```js
'olas/no-testing-outside-tests': ['error', { testFiles: ['**/*.test.*', 'src/test-utils.ts'] }]
```

`testFiles` replaces the defaults, so list every pattern your layout needs. To exempt one file and keep the defaults, turn the rule off for that file instead:

```js
{ files: ['src/test-utils.ts'], rules: { 'olas/no-testing-outside-tests': 'off' } }
```

## Why it is in `recommended`

The rule reads a module name and a file path, so it cannot misread code. Its one false positive is a test-support file outside the default layout, and one glob fixes that.

## Examples

```ts
// Reported, in src/app.ts
import { createTestController } from '@kontsedal/olas-core/testing'

// Fine, in src/app.test.ts
import { createTestController } from '@kontsedal/olas-core/testing'

// Fine in any file: the build erases it
import type { PluginRecorder } from '@kontsedal/olas-core/testing'
```
