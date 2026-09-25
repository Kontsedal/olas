/**
 * Every type a public signature names must be importable by the consumer who
 * reads that signature. This walks each published entry's built `.d.ts`
 * (run AFTER `pnpm build`): from every export it follows the type references,
 * and reports any that resolve to a declaration inside the package's `dist`
 * but are not exported from any of the package's entries. A consumer can see
 * such a type in a hover, but cannot write it down. A type exported from the
 * main entry counts for the sub-paths too: `/testing` signatures name types a
 * consumer imports from the package root.
 *
 * Type parameters, `typeof x` queries and the brand symbols' computed keys
 * are not type references, so they are not reported.
 *
 * Usage: tsx scripts/check-public-types.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type Node, Project, type SourceFile, SyntaxKind, type Symbol as TsSymbol } from 'ts-morph'

const root = resolve(import.meta.dirname, '..')
const failures: string[] = []
let checked = 0

const aliased = (s: TsSymbol): TsSymbol => s.getAliasedSymbol() ?? s

for (const name of readdirSync(join(root, 'packages'))) {
  const dir = join(root, 'packages', name)
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string
    private?: boolean
    exports?: Record<string, { types?: string }>
  }
  if (pkg.private || pkg.exports === undefined) continue
  const dist = join(dir, 'dist').replaceAll('\\', '/')

  const project = new Project({
    compilerOptions: { strict: true, skipLibCheck: true, moduleResolution: 100, module: 199 },
    skipAddingFilesFromTsConfig: true,
  })

  const entries: Array<{ subpath: string; entry: SourceFile }> = []
  for (const [subpath, cond] of Object.entries(pkg.exports)) {
    if (cond.types === undefined) continue
    entries.push({ subpath, entry: project.addSourceFileAtPath(join(dir, cond.types)) })
  }
  const exported = new Set<TsSymbol>()
  for (const { entry } of entries) {
    for (const sym of entry.getExportSymbols()) exported.add(aliased(sym))
  }

  for (const { subpath, entry } of entries) {
    checked += 1

    const seen = new Set<Node>()
    const queue: Array<{ node: Node; via: string }> = []
    for (const [exportName, decls] of entry.getExportedDeclarations()) {
      for (const d of decls) queue.push({ node: d, via: exportName })
    }

    while (queue.length > 0) {
      const { node, via } = queue.pop() as { node: Node; via: string }
      if (seen.has(node)) continue
      seen.add(node)
      for (const ref of node.getDescendantsOfKind(SyntaxKind.TypeReference)) {
        const nameNode = ref.getTypeName()
        const sym = nameNode.getSymbol()
        if (sym === undefined) continue
        const target = aliased(sym)
        for (const decl of target.getDeclarations()) {
          if (decl.isKind(SyntaxKind.TypeParameter)) continue
          const file = decl.getSourceFile().getFilePath()
          if (!file.startsWith(dist)) continue // another package, or the TS lib
          if (!exported.has(target)) {
            const key = `${pkg.name}${subpath === '.' ? '' : subpath.slice(1)}: ${target.getName()}`
            const line = `${key} (reached from ${via})`
            if (!failures.some((f) => f.startsWith(`${key} `))) failures.push(line)
          }
          queue.push({ node: decl, via })
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`✗ ${failures.length} type(s) appear in a public signature but are not exported:`)
  for (const f of failures.sort()) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ every type in a public signature is exported (${checked} entries checked)`)
