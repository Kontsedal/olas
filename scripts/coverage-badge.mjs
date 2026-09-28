// Turns the coverage totals into a shields.io endpoint badge for the README.
//
// `pnpm test:coverage` writes `coverage/coverage-summary.json` (the
// `json-summary` reporter in vitest.config.ts). This script reads its totals and
// writes the JSON that https://img.shields.io/endpoint renders. On a push to
// main, CI runs it and pushes the file to the `badges` branch, which the README
// badge reads (.github/workflows/ci.yml, the `coverage-badge` job).
//
//   node scripts/coverage-badge.mjs [out]   default out: coverage/badge.json
//
// Each percentage is rounded down, so the badge never shows more than was measured.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = process.argv[2] ?? join(root, 'coverage', 'badge.json')
const { total } = JSON.parse(readFileSync(join(root, 'coverage', 'coverage-summary.json'), 'utf8'))

const pct = (metric) => `${(Math.floor(total[metric].pct * 10) / 10).toFixed(1)}%`

const badge = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${pct('lines')} lines · ${pct('branches')} branches`,
  // The house teal, as on the README's other badges. A drop below the gates
  // fails CI before this runs, so the colour carries no state.
  color: '026f70',
}

writeFileSync(out, `${JSON.stringify(badge)}\n`)
console.log(`[coverage-badge] ${badge.message} -> ${out}`)
