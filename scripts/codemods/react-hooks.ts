/**
 * 1.0 codemod: the React adapter's renames.
 *
 *   import { use } from '@kontsedal/olas-react'   → import { useValue } …   (every reference too)
 *   import { KeepAlive } from '@kontsedal/olas-react' → import { SuspendOnUnmount } …
 *   const { mutateAsync } = useMutation(m)        → reported: pick `run` (promise) or `mutate` (void)
 *
 * The renames go through the language service, so a local binding named `use`
 * that shadows the import is left alone. Renaming an un-aliased specifier
 * renames the symbol, which rewrites every importer in the project at once, so
 * the script saves every changed file rather than only the one it is visiting.
 * `mutateAsync` is only reported: the right replacement depends on whether the
 * caller awaits the result.
 *
 * Usage: tsx scripts/codemods/react-hooks.ts <glob> [<glob> ...]
 */
import { Project, SyntaxKind } from 'ts-morph'

const RENAMES: Record<string, string> = { use: 'useValue', KeepAlive: 'SuspendOnUnmount' }

const isOlasReact = (spec: string): boolean =>
  spec === '@kontsedal/olas-react' || /(^|\/)packages\/react\/src(\/index)?$/.test(spec)

let total = 0
const project = new Project({ skipAddingFilesFromTsConfig: true })
for (const glob of process.argv.slice(2)) project.addSourceFilesAtPaths(glob)

for (const file of project.getSourceFiles()) {
  const path = file.getFilePath()
  if (path.includes('/node_modules/') || path.includes('/dist/')) continue
  let edits = 0

  for (const decl of file.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue()
    const resolved = decl.getModuleSpecifierSourceFile()?.getFilePath() ?? ''
    if (!isOlasReact(spec) && !resolved.endsWith('/packages/react/src/index.ts')) continue
    for (const named of decl.getNamedImports()) {
      const next = RENAMES[named.getName()]
      if (next === undefined) continue
      const alias = named.getAliasNode()
      if (alias !== undefined) {
        // `import { use as read }` — only the imported name changes.
        named.getNameNode().replaceWithText(next)
      } else if (decl.getNamedImports().some((n) => n.getName() === next)) {
        // Both names already imported (`KeepAlive` next to `SuspendOnUnmount`):
        // repoint the references, then drop the old specifier.
        for (const ref of named.getNameNode().findReferencesAsNodes()) {
          if (ref.getSourceFile() === file && ref !== named.getNameNode()) ref.replaceWithText(next)
        }
        named.remove()
      } else {
        named.getNameNode().rename(next)
      }
      edits += 1
    }
  }

  for (const id of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== 'mutateAsync') continue
    console.log(
      `[react-hooks] MANUAL ${path}:${id.getStartLineNumber()} mutateAsync → run (promise) or mutate (void)`,
    )
  }

  total += edits
}

let saved = 0
for (const file of project.getSourceFiles()) {
  const path = file.getFilePath()
  if (file.isSaved() || path.includes('/node_modules/') || path.includes('/dist/')) continue
  file.saveSync()
  saved += 1
  console.log(`[react-hooks] saved ${path}`)
}
console.log(`[react-hooks] ${total} renames, ${saved} files saved`)
