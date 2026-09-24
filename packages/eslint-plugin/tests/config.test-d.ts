// Type-level test: the configs fit ESLint's own config types, so a typed
// `eslint.config.ts` accepts them without a cast. Checked by `tsc`, not run.
import type { Linter } from 'eslint'
import { defineConfig } from 'eslint/config'
import olas, { type rules } from '../src'

export const asArray: Linter.Config[] = [olas.configs.recommended, olas.configs.strict]
export const viaDefineConfig = defineConfig([olas.configs.recommended])

// A rule with options, set on its own after a config.
export const withOptions = defineConfig([
  olas.configs.recommended,
  {
    rules: {
      'olas/honor-abort-signal': ['error', { ignorePattern: '^unused' }],
      'olas/no-testing-outside-tests': ['error', { testFiles: ['**/*.test.ts', 'e2e/**'] }],
    },
  },
])

// The option shapes are typed on the rule modules.
export const signalOptions: (typeof rules)['honor-abort-signal']['defaultOptions'] = [
  { ignorePattern: '^_' },
]
export const testingOptions: (typeof rules)['no-testing-outside-tests']['defaultOptions'] = [
  { testFiles: ['**/*.test.*'] },
]
export const badTestingOptions: (typeof rules)['no-testing-outside-tests']['defaultOptions'] = [
  // @ts-expect-error `testFiles` is a list of globs, not one.
  { testFiles: '**/*.test.*' },
]
