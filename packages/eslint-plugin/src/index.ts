import type { TSESLint } from '@typescript-eslint/utils'
import type { ESLint, Linter } from 'eslint'
import { cancelBeforeOptimistic } from './rules/cancel-before-optimistic'
import { defineAtModuleScope } from './rules/define-at-module-scope'
import { honorAbortSignal } from './rules/honor-abort-signal'
import { noAsyncControllerFactory } from './rules/no-async-controller-factory'
import { noNetworkInComponents } from './rules/no-network-in-components'
import { noReactHooksInControllers } from './rules/no-react-hooks-in-controllers'
import { noTestingOutsideTests } from './rules/no-testing-outside-tests'
import { optimisticReturnsSnapshot } from './rules/optimistic-returns-snapshot'

/**
 * Every rule the plugin ships, keyed by name. A flat config turns one on as
 * `'olas/<name>'`.
 */
export const rules = {
  'cancel-before-optimistic': cancelBeforeOptimistic,
  'define-at-module-scope': defineAtModuleScope,
  'honor-abort-signal': honorAbortSignal,
  'no-async-controller-factory': noAsyncControllerFactory,
  'no-network-in-components': noNetworkInComponents,
  'no-react-hooks-in-controllers': noReactHooksInControllers,
  'no-testing-outside-tests': noTestingOutsideTests,
  'optimistic-returns-snapshot': optimisticReturnsSnapshot,
} satisfies Record<string, TSESLint.RuleModule<string, unknown[]>>

/**
 * The plugin, typed with ESLint's own types so an `eslint.config.ts` that uses
 * `defineConfig` or `Linter.Config[]` accepts the configs as they are. The rule
 * modules are built with `@typescript-eslint/utils`, whose types ESLint's do
 * not accept, so they are cast at this one boundary.
 */
export type OlasEslintPlugin = ESLint.Plugin & {
  configs: { recommended: Linter.Config; strict: Linter.Config }
}

/**
 * The plugin, the package's default export: `rules`, plus the `recommended`
 * and `strict` flat configs. Each config registers the plugin under `olas`.
 */
const plugin: OlasEslintPlugin = {
  meta: { name: '@kontsedal/olas-eslint-plugin' },
  rules: rules as unknown as NonNullable<ESLint.Plugin['rules']>,
  configs: { recommended: {}, strict: {} },
}

/**
 * `recommended` turns on every rule except the two opt-in ones,
 * `no-network-in-components` and `honor-abort-signal`. `strict` adds both,
 * and raises `cancel-before-optimistic` to an error.
 *
 * ```js
 * // eslint.config.js
 * import olas from '@kontsedal/olas-eslint-plugin'
 * export default [olas.configs.recommended]
 * ```
 */
plugin.configs.recommended = {
  name: 'olas/recommended',
  plugins: { olas: plugin },
  rules: {
    'olas/cancel-before-optimistic': 'warn',
    'olas/define-at-module-scope': 'error',
    'olas/no-async-controller-factory': 'error',
    'olas/no-react-hooks-in-controllers': 'error',
    'olas/no-testing-outside-tests': 'error',
    'olas/optimistic-returns-snapshot': 'error',
  },
}
plugin.configs.strict = {
  name: 'olas/strict',
  plugins: { olas: plugin },
  rules: {
    ...plugin.configs.recommended.rules,
    'olas/cancel-before-optimistic': 'error',
    'olas/honor-abort-signal': 'error',
    'olas/no-network-in-components': 'error',
  },
}

export default plugin
