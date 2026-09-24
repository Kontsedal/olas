// Vitest config for the Stryker mutation run (`pnpm mutation`): the root
// config, narrowed to core's tests and without coverage, so each mutant runs
// only what can kill it. `include` is set after the merge, because
// `mergeConfig` concatenates arrays: merged in, it would add core's glob to
// the root's every-package glob instead of replacing it.
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

const config = mergeConfig(base, defineConfig({ test: { coverage: { enabled: false } } }))
config.test.include = ['packages/core/tests/**/*.test.ts']

export default config
