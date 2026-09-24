/**
 * API reports: one `etc/<name>.api.md` per published entry point, checked in,
 * so any change to a package's public surface shows up as a reviewable diff.
 *
 *   pnpm api:check    CI: fail when a report no longer matches the built .d.ts
 *   pnpm api:update   rewrite the reports from the built .d.ts
 *
 * Both read `dist/*.d.ts`, so run `pnpm build` first. Each run also writes the
 * doc model (`temp/api-model/*.api.json`, gitignored) that `pnpm docs:api`
 * turns into the site's reference pages.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const local = process.argv.includes('--local')
const modelDir = join(root, 'temp', 'api-model')
mkdirSync(modelDir, { recursive: true })

/** Every published package's entries: `.` always, plus sub-paths like `./testing`. */
function entries() {
  const out = []
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkgDir = join(root, 'packages', dir)
    const pkgPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgPath)) continue
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.private) continue
    const unscoped = pkg.name.replace(/^@[^/]+\//, '')
    for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
      const types = typeof target === 'string' ? undefined : target.types
      if (types === undefined) continue
      const suffix = sub === '.' ? '' : `-${sub.replace(/^\.\//, '').replace(/\//g, '-')}`
      out.push({
        pkgDir,
        pkgPath,
        name: pkg.name,
        sub,
        dts: join(pkgDir, types),
        report: `${unscoped}${suffix}`,
      })
    }
  }
  return out
}

let failed = 0
for (const e of entries()) {
  if (!existsSync(e.dts)) {
    console.error(`[api-report] ${e.name} ${e.sub}: ${e.dts} is missing. Run \`pnpm build\` first.`)
    failed += 1
    continue
  }
  mkdirSync(join(e.pkgDir, 'etc'), { recursive: true })
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: e.pkgDir,
      mainEntryPointFilePath: e.dts,
      bundledPackages: [],
      // The repo checks files out as LF (.gitattributes), on every platform.
      newlineKind: 'lf',
      compiler: {
        // The analysis reads only the built declarations, so it needs no
        // project: just the libs the declarations reference.
        overrideTsconfig: {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            jsx: 'react-jsx',
            strict: true,
            skipLibCheck: true,
            types: [],
          },
          files: [e.dts],
        },
      },
      apiReport: {
        enabled: true,
        reportFileName: `${e.report}.api.md`,
        reportFolder: join(e.pkgDir, 'etc'),
        reportTempFolder: join(root, 'temp', 'api-report'),
      },
      docModel: {
        // One model per package: api-documenter keys models by package name.
        enabled: e.sub === '.',
        apiJsonFilePath: join(modelDir, `${e.report}.api.json`),
      },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: 'warning' } },
        extractorMessageReporting: {
          default: { logLevel: 'warning' },
          // Olas marks no release stages (@public/@beta): everything exported is public.
          'ae-missing-release-tag': { logLevel: 'none' },
          // TSDoc coverage is tracked in BACKLOG, not enforced here. Overloaded
          // hooks carry their docs on the overloads, which this rule misses.
          'ae-undocumented': { logLevel: 'none' },
          // A third-party package's own declarations (eslint's `.cts` types)
          // are read to resolve references, not analysed as an entry.
          'ae-wrong-input-file-type': { logLevel: 'none' },
          // A main entry must export every type its signatures name. A sub-path
          // such as `/testing` names core's `Root` through the shared chunk,
          // and a user imports it from the main entry.
          'ae-forgotten-export': { logLevel: e.sub === '.' ? 'warning' : 'none' },
        },
        // TSDoc style is not enforced on the hover docs; the reports track the surface.
        tsdocMessageReporting: { default: { logLevel: 'none' } },
      },
    },
    configObjectFullPath: join(e.pkgDir, 'api-extractor.json'),
    packageJsonFullPath: e.pkgPath,
  })
  let problems = 0
  const result = Extractor.invoke(config, {
    localBuild: local,
    showVerboseMessages: false,
    messageCallback(message) {
      // Report-changed notices are summarised below.
      // The analysis runs on api-extractor's bundled TypeScript, which reads
      // the declarations the workspace's newer compiler emitted.
      const quiet = [
        'console-api-report-changed',
        'console-api-report-copied',
        'console-api-report-created',
        'console-api-report-unchanged',
        'console-compiler-version-notice',
        'console-preamble',
        'console-writing-doc-model-file',
      ]
      if (quiet.includes(message.messageId)) {
        message.handled = true
      } else if (message.logLevel === 'warning' || message.logLevel === 'error') {
        // Counted here rather than from `result.warningCount`, which also
        // counts the notices silenced above.
        problems += 1
      }
    },
  })
  const label = `${e.name}${e.sub === '.' ? '' : e.sub.slice(1)}`
  if (result.apiReportChanged && !local) {
    console.error(
      `[api-report] ${label}: the public API changed. Run \`pnpm api:update\` and commit etc/${e.report}.api.md.`,
    )
    failed += 1
  } else if (!result.succeeded || problems > 0) {
    console.error(`[api-report] ${label}: ${problems} problem(s), printed above`)
    failed += 1
  } else if (result.apiReportChanged) {
    console.log(`[api-report] ${label}: updated etc/${e.report}.api.md`)
  }
}
console.log(`[api-report] ${failed === 0 ? 'ok' : `${failed} entry(ies) need attention`}`)
process.exit(failed === 0 ? 0 : 1)
