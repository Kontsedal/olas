// Verify the BUILT dist of every published package (run AFTER `pnpm build`):
//   1. no `__DEV__` literal leaked into the production output's *executable
//      code* (consumers would otherwise hit `ReferenceError: __DEV__ is not
//      defined`). Comments are stripped before this check — the dist ships
//      unminified with JSDoc, and several doc comments mention `__DEV__` on
//      purpose; a comment cannot throw. Comment-only hits print a warning;
//   2. the ESM entry `import`s and the CJS entry `require`s, touching one real
//      export — catches a dist that typechecks but won't load (bad `exports`,
//      ESM/CJS interop breakage, a missing built file).
// Exits non-zero on any failure. Zero-dependency; pairs with publint + attw
// (which check the packaging metadata) — this checks the artifacts actually run.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)

const entryFrom = (pkg, dir, kind) => {
  const dot = pkg.exports?.['.']
  const cond = kind === 'esm' ? dot?.import : dot?.require
  const rel = cond?.default ?? cond ?? (kind === 'esm' ? pkg.module : pkg.main) ?? dot?.default
  return typeof rel === 'string' ? resolve(dir, rel) : null
}

// Blank out comments so the `__DEV__` guard tests CODE, not prose. The dist is
// shipped unminified with JSDoc intact, and several doc comments legitimately
// mention `__DEV__` (e.g. "call sites guard with `if (__DEV__)`") — a substring
// scan over the raw file flags those as leaks. Hand-rolled scanner because this
// script is deliberately zero-dependency.
//
// Replaces comment bodies with spaces (preserving length/offsets) and tracks
// string + template-literal state so a `//` inside a string isn't mistaken for
// a comment. Regex literals are NOT tracked — a `/` after an operator could in
// principle start a mis-detected comment, which is why a raw-file hit that
// vanishes after stripping is reported as a WARNING rather than silently
// dropped: an over-stripped real leak still reaches a human.
const stripComments = (src) => {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      for (let k = i; k < stop; k++) out += src[k] === '\n' ? '\n' : ' '
      i = stop
    } else if (c === '/' && next === '/') {
      let stop = src.indexOf('\n', i)
      if (stop === -1) stop = n
      out += ' '.repeat(stop - i)
      i = stop
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out += c
      i++
      while (i < n) {
        out += src[i]
        if (src[i] === '\\') {
          if (i + 1 < n) out += src[++i]
          i++
          continue
        }
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
    } else {
      out += c
      i++
    }
  }
  return out
}

const snippet = (src, idx, pad = 90) =>
  src
    .slice(Math.max(0, idx - pad), Math.min(src.length, idx + pad))
    .replace(/\s+/g, ' ')
    .trim()

const failures = []
const warnings = []
const checked = []

for (const name of readdirSync(join(root, 'packages'))) {
  const dir = join(root, 'packages', name)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.private) continue // skip the private integration package

  const distDir = join(dir, 'dist')
  if (!existsSync(distDir)) {
    failures.push(`${pkg.name}: no dist/ — run \`pnpm build\` first`)
    continue
  }
  checked.push(pkg.name)

  // 1. __DEV__ leak guard — code only; comment mentions are harmless.
  for (const f of readdirSync(distDir)) {
    if (!/\.(mjs|cjs)$/.test(f)) continue
    const raw = readFileSync(join(distDir, f), 'utf8')
    if (!raw.includes('__DEV__')) continue
    const code = stripComments(raw)
    const at = code.indexOf('__DEV__')
    if (at !== -1) {
      failures.push(
        `${pkg.name}: \`__DEV__\` leaked into executable code in dist/${f} ` +
          `(build define misfired) — near: ${snippet(code, at)}`,
      )
    } else {
      warnings.push(
        `${pkg.name}: dist/${f} mentions \`__DEV__\` in a comment only (not code) — harmless`,
      )
    }
  }

  // 2. ESM import.
  const esm = entryFrom(pkg, dir, 'esm')
  if (!esm || !existsSync(esm)) {
    failures.push(`${pkg.name}: ESM entry missing (${esm ?? 'unresolved from exports/module'})`)
  } else {
    try {
      const mod = await import(pathToFileURL(esm).href)
      if (Object.keys(mod).length === 0) failures.push(`${pkg.name}: ESM entry exports nothing`)
    } catch (err) {
      failures.push(`${pkg.name}: ESM import failed — ${err?.message ?? err}`)
    }
  }

  // 3. CJS require.
  const cjs = entryFrom(pkg, dir, 'cjs')
  if (!cjs || !existsSync(cjs)) {
    failures.push(`${pkg.name}: CJS entry missing (${cjs ?? 'unresolved from exports/main'})`)
  } else {
    try {
      const mod = require(cjs)
      if (!mod || (typeof mod === 'object' && Object.keys(mod).length === 0)) {
        failures.push(`${pkg.name}: CJS entry exports nothing`)
      }
    } catch (err) {
      failures.push(`${pkg.name}: CJS require failed — ${err?.message ?? err}`)
    }
  }
}

for (const w of warnings) console.warn(`  ! ${w}`)

if (failures.length > 0) {
  console.error(`✗ dist smoke test FAILED (${failures.length}):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `✓ dist smoke test passed for ${checked.length} published packages ` +
    `(ESM import + CJS require + no __DEV__ leak in code):\n  ${checked.join(', ')}`,
)
