// Type-level test: the configs fit ESLint's own config types, so a typed
// `eslint.config.ts` accepts them without a cast. Checked by `tsc`, not run.
import type { Linter } from 'eslint'
import { defineConfig } from 'eslint/config'
import olas from '../src'

export const asArray: Linter.Config[] = [olas.configs.recommended, olas.configs.strict]
export const viaDefineConfig = defineConfig([olas.configs.recommended])
