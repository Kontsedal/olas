/**
 * The `recommended` config over the example apps' source, as a check against
 * false positives: the examples are idiomatic Olas, so an error there is a
 * rule bug until shown otherwise. Warnings are listed in the assertion, so a
 * new one shows up in review.
 */
import { resolve } from 'node:path'
import tsParser from '@typescript-eslint/parser'
import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'
import plugin from '../src'

const repo = resolve(__dirname, '../../..')

describe('recommended config on the example apps', () => {
  test('reports no errors, and only the warnings listed here', async () => {
    const eslint = new ESLint({
      cwd: repo,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.ts', '**/*.tsx'],
          languageOptions: {
            parser: tsParser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
        },
        plugin.configs.recommended,
      ],
    })
    const results = await eslint.lintFiles(['examples/*/src/**/*.{ts,tsx}'])
    expect(results.length).toBeGreaterThan(50)
    const findings = results.flatMap((r) =>
      r.messages.map((m) => ({
        file: r.filePath.slice(repo.length + 1).replace(/\\/g, '/'),
        line: m.line,
        rule: m.ruleId,
        severity: m.severity === 2 ? 'error' : 'warn',
      })),
    )
    expect(findings.filter((f) => f.severity === 'error')).toEqual([])
    expect(findings).toEqual([])
  })
})
