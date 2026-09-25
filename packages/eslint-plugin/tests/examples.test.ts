/**
 * Both configs over the example apps' source and tests, as a check against
 * false positives: the examples are idiomatic Olas, so a finding there is a
 * rule bug until shown otherwise. `strict` is run too, so the opt-in rules
 * get the same check. The tests are linted because `no-testing-outside-tests`
 * must pass the test files that import `@kontsedal/olas-core/testing`.
 */
import { resolve } from 'node:path'
import tsParser from '@typescript-eslint/parser'
import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'
import plugin from '../src'

const repo = resolve(__dirname, '../../..')

describe('the configs on the example apps', () => {
  test.each(['recommended', 'strict'] as const)('%s reports nothing', async (name) => {
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
        plugin.configs[name],
      ],
    })
    const results = await eslint.lintFiles([
      'examples/*/src/**/*.{ts,tsx}',
      'examples/*/tests/**/*.{ts,tsx}',
    ])
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
