// Verify the BUILT dist of every published package (run AFTER `pnpm build`):
//   1. no `__DEV__` literal leaked into the production output (consumers would
//      otherwise hit `ReferenceError: __DEV__ is not defined`);
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

const failures = []
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

  // 1. __DEV__ leak guard.
  for (const f of readdirSync(distDir)) {
    if (!/\.(mjs|cjs)$/.test(f)) continue
    if (readFileSync(join(distDir, f), 'utf8').includes('__DEV__')) {
      failures.push(
        `${pkg.name}: \`__DEV__\` literal leaked into dist/${f} (build define misfired)`,
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

if (failures.length > 0) {
  console.error(`✗ dist smoke test FAILED (${failures.length}):`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(
  `✓ dist smoke test passed for ${checked.length} published packages ` +
    `(ESM import + CJS require + no __DEV__ leak):\n  ${checked.join(', ')}`,
)
