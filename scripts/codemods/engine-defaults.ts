/**
 * 1.0 codemod: query defaults live on the engine.
 *
 *   createRoot(app, { deps, queries: queryEngine(), defaultQueryOptions: { staleTime: 1 }, refetchOnWindowFocus: true })
 *     → createRoot(app, { deps, queries: queryEngine({ defaults: { staleTime: 1, refetchOnWindowFocus: true } }) })
 *
 *   queryEngine({ defaultQueryOptions: X }) → queryEngine({ defaults: X })
 *
 * Applies to `createRoot` and `createTestController` option literals.
 * Syntactic, so it needs no type information.
 *
 * Usage: tsx scripts/codemods/engine-defaults.ts <glob> [<glob> ...]
 */
import { type Node, type ObjectLiteralExpression, Project, SyntaxKind } from 'ts-morph'

type Edit = { start: number; end: number; text: string }

const MOVED = ['defaultQueryOptions', 'refetchOnWindowFocus', 'refetchOnReconnect'] as const

function prop(obj: ObjectLiteralExpression, name: string) {
  return obj
    .getProperties()
    .find(
      (p) =>
        (p.isKind(SyntaxKind.PropertyAssignment) ||
          p.isKind(SyntaxKind.ShorthandPropertyAssignment)) &&
        p.getName() === name,
    )
}

function valueText(p: Node): string {
  if (p.isKind(SyntaxKind.PropertyAssignment)) return p.getInitializerOrThrow().getText()
  if (p.isKind(SyntaxKind.ShorthandPropertyAssignment)) return p.getName()
  throw new Error('unexpected property kind')
}

function removeProp(p: Node): Edit {
  const text = p.getSourceFile().getFullText()
  let end = p.getEnd()
  const m = /^\s*,/.exec(text.slice(end))
  if (m) end += m[0].length
  return { start: p.getFullStart(), end, text: '' }
}

/** Build the `defaults` expression from the moved properties. */
function defaultsText(values: Map<string, string>): string {
  const base = values.get('defaultQueryOptions')
  const flags = ['refetchOnWindowFocus', 'refetchOnReconnect']
    .filter((f) => values.has(f))
    .map((f) => `${f}: ${values.get(f)}`)
  if (flags.length === 0) return base as string
  if (base === undefined) return `{ ${flags.join(', ')} }`
  if (base.trim().startsWith('{')) {
    // Merge into the literal. The flat flag used to LOSE to the same field in
    // `defaultQueryOptions`, so it goes first and the literal's field wins.
    const inner = base.trim().slice(1, -1).trim()
    return `{ ${flags.join(', ')}${inner.length > 0 ? `, ${inner}` : ''} }`
  }
  return `{ ${flags.join(', ')}, ...${base} }`
}

let total = 0
const project = new Project({ skipAddingFilesFromTsConfig: true })
for (const glob of process.argv.slice(2)) project.addSourceFilesAtPaths(glob)

for (const file of project.getSourceFiles()) {
  const path = file.getFilePath()
  if (path.includes('/node_modules/') || path.includes('/dist/')) continue
  const edits: Edit[] = []

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText()

    if (callee === 'queryEngine') {
      const obj = call.getArguments()[0]
      if (!obj?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
      const dqo = prop(obj, 'defaultQueryOptions')
      if (dqo?.isKind(SyntaxKind.PropertyAssignment)) {
        const n = dqo.getNameNode()
        edits.push({ start: n.getStart(), end: n.getEnd(), text: 'defaults' })
      }
      continue
    }

    if (callee !== 'createRoot' && callee !== 'createTestController') continue
    const obj = call.getArguments()[1]
    if (!obj?.isKind(SyntaxKind.ObjectLiteralExpression)) continue
    const values = new Map<string, string>()
    const toRemove: Node[] = []
    for (const name of MOVED) {
      const p = prop(obj, name)
      if (p === undefined) continue
      values.set(name, valueText(p))
      toRemove.push(p)
    }
    if (values.size === 0) continue
    const defaults = defaultsText(values)
    const queries = prop(obj, 'queries')
    const init = queries?.isKind(SyntaxKind.PropertyAssignment)
      ? queries.getInitializer()
      : undefined
    if (
      init?.isKind(SyntaxKind.CallExpression) &&
      init.getExpression().getText() === 'queryEngine' &&
      init.getArguments().length === 0
    ) {
      // `queryEngine()` → `queryEngine({ defaults })`; the moved props go away.
      const open = init.getEnd() - 1
      edits.push({ start: open, end: open, text: `{ defaults: ${defaults} }` })
      for (const p of toRemove) edits.push(removeProp(p))
    } else if (queries === undefined) {
      // No engine given (createTestController's default one): replace the
      // first moved prop in place with an explicit engine.
      const [first, ...rest] = toRemove
      if (first === undefined) continue
      edits.push({
        start: first.getStart(),
        end: first.getEnd(),
        text: `queries: queryEngine({ defaults: ${defaults} })`,
      })
      for (const p of rest) edits.push(removeProp(p))
    } else {
      console.log(`[engine-defaults] MANUAL ${path}:${call.getStartLineNumber()}`)
    }
  }

  if (edits.length === 0) continue
  let text = file.getFullText()
  edits.sort((a, b) => b.start - a.start || b.end - a.end)
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  file.replaceWithText(text)
  file.saveSync()
  total += edits.length
  console.log(`[engine-defaults] ${edits.length.toString().padStart(4)} ${path}`)
}
console.log(`[engine-defaults] ${total} edits`)
