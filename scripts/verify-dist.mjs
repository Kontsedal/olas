// Verify the BUILT dist of every published package (run AFTER `pnpm build`):
//   1. no `__DEV__` literal leaked into the production output's *executable
//      code* (consumers would otherwise hit `ReferenceError: __DEV__ is not
//      defined`). Comments are stripped before this check — the dist ships
//      unminified with JSDoc, and several doc comments mention `__DEV__` on
//      purpose; a comment cannot throw. Comment-only hits print a warning;
//   2. the entry `import`s, and `require()`s too — the packages are ESM-only,
//      and Node >= 20.19 loads ESM through `require()`, so a CommonJS consumer
//      still works. Catches a dist that typechecks but won't load (bad
//      `exports`, top-level await breaking `require()`, a missing built file).
//   3. a controllers-only bundle built from core's dist carries neither forms
//      nor the query engine. `tsdown` emits one shared chunk, so this rests on
//      statement-level dead-code elimination, which one computed class-field
//      key was once enough to defeat. A positive control proves the check sees
//      both subsystems when they are imported.
//   5. every `development` export condition points at a build that loads and
//      exports the same names, and core's two builds differ where they must:
//      the production build emits no devtools events, the development build does.
// Exits non-zero on any failure. Pairs with publint + attw (which check the
// packaging metadata) — this checks the artifacts actually run.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const require = createRequire(import.meta.url)

const entryFrom = (pkg, dir) => {
  const rel = pkg.exports?.['.']?.default
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
    if (!/\.js$/.test(f)) continue
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
  const esm = entryFrom(pkg, dir)
  if (!esm || !existsSync(esm)) {
    failures.push(`${pkg.name}: entry missing (${esm ?? 'unresolved from exports'})`)
  } else {
    try {
      const mod = await import(pathToFileURL(esm).href)
      if (Object.keys(mod).length === 0) failures.push(`${pkg.name}: ESM entry exports nothing`)
    } catch (err) {
      failures.push(`${pkg.name}: ESM import failed — ${err?.message ?? err}`)
    }
  }

  // 3. require() of the ESM entry, as a CommonJS consumer on Node >= 20.19.
  if (esm && existsSync(esm)) {
    try {
      const mod = require(esm)
      if (!mod || (typeof mod === 'object' && Object.keys(mod).length === 0)) {
        failures.push(`${pkg.name}: require() of the entry exports nothing`)
      }
    } catch (err) {
      failures.push(`${pkg.name}: require() of the ESM entry failed — ${err?.message ?? err}`)
    }
  }

  // 5. The `development` condition's build: it exists, loads, and exports the
  // same names as the default entry, so a bundler that picks it in dev sees
  // the same module shape it gets in production.
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    if (typeof target !== 'object' || target.development === undefined) continue
    const devPath = resolve(dir, target.development)
    const prodPath = resolve(dir, target.default)
    if (!existsSync(devPath)) {
      failures.push(`${pkg.name} ${sub}: the development build ${target.development} is missing`)
      continue
    }
    try {
      const dev = Object.keys(await import(pathToFileURL(devPath).href))
        .sort()
        .join()
      const prod = Object.keys(await import(pathToFileURL(prodPath).href))
        .sort()
        .join()
      if (dev !== prod)
        failures.push(`${pkg.name} ${sub}: the development build exports different names`)
    } catch (err) {
      failures.push(
        `${pkg.name} ${sub}: the development build failed to load — ${err?.message ?? err}`,
      )
    }
  }
}

// 5b. The two core builds differ where they should: the production build
// emits no devtools events, and the development build does. Without the second
// half, `@kontsedal/olas-devtools` would show an empty tree against the
// published package.
{
  const probe = async (rel) => {
    const core = await import(pathToFileURL(join(root, 'packages', 'core', 'dist', rel)).href)
    const events = []
    const r = core.createRoot(
      core.defineController(() => ({})),
      { deps: {} },
    )
    const unsubscribe = r.debug.subscribe((e) => events.push(e.type))
    r.dispose()
    unsubscribe()
    return events.length
  }
  const corePkg = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8'))
  if (corePkg.exports?.['.']?.development === undefined) {
    failures.push(
      'core: no `development` export condition, so devtools get no events from the published package',
    )
  } else if (existsSync(join(root, 'packages', 'core', 'dist', 'dev', 'index.js'))) {
    const prodEvents = await probe('index.js')
    const devEvents = await probe('dev/index.js')
    if (prodEvents !== 0)
      failures.push(`core: the production build emitted ${prodEvents} devtools event(s)`)
    if (devEvents === 0) failures.push('core: the development build emitted no devtools events')
  }
}

// 4. Tree-shaking against the built dist.
const coreEntry = join(root, 'packages', 'core', 'dist', 'index.js')
if (existsSync(coreEntry)) {
  const bundle = async (names) => {
    const contents = `export { ${names} } from ${JSON.stringify(coreEntry.replaceAll('\\', '/'))}`
    const out = await build({
      stdin: { contents, resolveDir: root, loader: 'js' },
      bundle: true,
      write: false,
      format: 'esm',
      treeShaking: true,
      external: ['@preact/signals-core'],
      logLevel: 'silent',
    })
    return out.outputFiles[0].text
  }
  const FORMS = /olas\.form/
  // esbuild emits `var QueryClient = class {`. A doc comment that names the
  // class must not count.
  const ENGINE = /\bQueryClient = class\b|\bclass QueryClient\b/
  const lean = await bundle('createRoot, defineController, signal, computed')
  if (FORMS.test(lean)) failures.push('core: a controllers-only bundle from dist retains forms')
  if (ENGINE.test(lean)) {
    failures.push('core: a controllers-only bundle from dist retains the query engine')
  }
  const full = await bundle('createRoot, createForm, createQuery, queryEngine')
  if (!FORMS.test(full) || !ENGINE.test(full)) {
    failures.push(
      'core: the tree-shaking check no longer sees forms or the engine when they ARE imported',
    )
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
    `(import + require() of ESM + no __DEV__ leak in code), and core's dist tree-shakes:\n  ${checked.join(', ')}`,
)
