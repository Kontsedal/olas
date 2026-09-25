// Restores the upper bound on internal peer ranges after `changeset version`.
//
// Every package declares its peers on sibling packages with a ceiling at the
// next major (`>=0.3.0 <1.0.0`), so an app cannot pair a 1.x satellite with a
// 2.x core. `changeset version` rewrites a peer range whenever the sibling's
// new version falls outside it. Changesets 2 wrote only a floor (`>=1.0.0`), so
// the ceiling was gone exactly when a major landed. Changesets 3.0.3 keeps it
// (`>=2.0.0 <3.0.0`); this script stays as the backstop, and `--check` catches
// a hand-edited range. Which packages need a major for a moved range is
// `check-peer-bumps.mjs`'s job.
//
//   node scripts/pin-peer-ranges.mjs          rewrite `>=X.Y.Z` to `>=X.Y.Z <(X+1).0.0`
//   node scripts/pin-peer-ranges.mjs --check  exit 1 if any internal peer range lacks a ceiling
//
// A range already holding `<`, `^`, `~`, `||` or a `workspace:` protocol is left alone.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const INTERNAL = '@kontsedal/olas-'
const FLOOR_ONLY = /^>=\s*(\d+)\.(\d+)\.(\d+)$/
const check = process.argv.includes('--check')

const root = join(import.meta.dirname, '..', 'packages')
const problems = []
let rewritten = 0

for (const dir of readdirSync(root, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  const file = join(root, dir.name, 'package.json')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const pkg = JSON.parse(text)
  if (pkg.private || pkg.peerDependencies === undefined) continue
  let changed = false
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    if (!name.startsWith(INTERNAL)) continue
    const floor = FLOOR_ONLY.exec(range.trim())
    if (floor === null) continue
    const next = `${range.trim()} <${Number(floor[1]) + 1}.0.0`
    if (check) {
      problems.push(
        `${pkg.name}: peer "${name}" is "${range}", with no upper bound (expected "${next}")`,
      )
      continue
    }
    pkg.peerDependencies[name] = next
    changed = true
    rewritten += 1
    console.log(`${pkg.name}: ${name} "${range}" -> "${next}"`)
  }
  if (changed) {
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    writeFileSync(file, JSON.stringify(pkg, null, 2).replaceAll('\n', eol) + eol)
  }
}

if (check) {
  if (problems.length > 0) {
    for (const p of problems) console.error(p)
    console.error(
      'Run `node scripts/pin-peer-ranges.mjs` (it runs as part of `pnpm version-packages`).',
    )
    process.exit(1)
  }
  console.log('✓ every internal peer range has an upper bound')
} else {
  console.log(`pin-peer-ranges: ${rewritten} range(s) given an upper bound`)
}
