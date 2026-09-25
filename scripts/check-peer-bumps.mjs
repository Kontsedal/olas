// Fails when a pending release would push a sibling out of a package's peer
// range without a major changeset for that package.
//
// Every internal peer range has a ceiling at the next major (see
// `pin-peer-ranges.mjs`), so a core major leaves each satellite's range behind.
// Changesets 2 bumped such a dependent by a major. Changesets 3 bumps it by a
// patch and rewrites the range: `@kontsedal/olas-react` 1.0.1 would require
// core 2, and an app on core 1 with `^1.0.0` would get it. A narrower peer
// range is a breaking change, so the dependent has to be released as a major,
// and a changeset has to say so.
//
//   node scripts/check-peer-bumps.mjs   exit 1 if a dependent lacks the major it needs
//
// It reads the pending `.changeset/*.md` files, not `changeset status`, which
// also fails on a package changed without a changeset. It runs in CI and at the
// start of `pnpm version-packages`.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'

const INTERNAL = '@kontsedal/olas-'
const RANK = { none: 0, patch: 1, minor: 2, major: 3 }

const repo = join(import.meta.dirname, '..')
const changesetDir = join(repo, '.changeset')
const packagesDir = join(repo, 'packages')

const packages = new Map()
for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(packagesDir, dir.name, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  if (!pkg.private) packages.set(pkg.name, pkg)
}

// The strongest bump each package gets from the pending changesets.
const bumps = new Map()
for (const file of readdirSync(changesetDir)) {
  if (!file.endsWith('.md') || file === 'README.md') continue
  const text = readFileSync(join(changesetDir, file), 'utf8')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (frontmatter === null) continue
  for (const [name, type] of Object.entries(parseYaml(frontmatter[1]) ?? {})) {
    if (!(type in RANK)) throw new Error(`${file}: unknown bump "${type}" for ${name}`)
    if (RANK[type] > RANK[bumps.get(name) ?? 'none']) bumps.set(name, type)
  }
}

const nextVersion = (name) => {
  const pkg = packages.get(name)
  const type = bumps.get(name) ?? 'none'
  return type === 'none' ? pkg.version : semver.inc(pkg.version, type)
}

const problems = []
for (const [name, pkg] of packages) {
  if (bumps.get(name) === 'major') continue
  for (const [peer, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!peer.startsWith(INTERNAL) || !packages.has(peer)) continue
    const next = nextVersion(peer)
    if (semver.satisfies(next, range)) continue
    problems.push(
      `${name}: its peer range "${range}" excludes ${peer}@${next}, so it needs a major changeset` +
        ` (it has ${bumps.get(name) ?? 'none'})`,
    )
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p)
  console.error(
    'A peer range that drops a major is a breaking change. Add a changeset that bumps each' +
      ' package above as major, and say in it which peer it now requires.',
  )
  process.exit(1)
}
console.log('✓ every package a pending release leaves out of its peer range has a major changeset')
