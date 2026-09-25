/**
 * 1.0 codemod: the root handle stops being the app api.
 *
 *   root.increment()      → root.api.increment()
 *   root.__debug.x        → root.debug.x
 *   const { a } = root    → const { a } = root.api
 *
 * Type-driven: an expression counts as a root when its type carries the 0.x
 * root controls (`__debug`, `waitForIdle`, `applyDehydratedEntry`). Run it
 * BEFORE the new `Root` type is in the `dist` it resolves against.
 *
 * Edits are position-based insertions applied back to front, so a match
 * nested inside another match keeps both edits.
 *
 * Usage: tsx scripts/codemods/root-api.ts <tsconfig> [<tsconfig> ...]
 */
import { type Node, Project, SyntaxKind, type Type } from 'ts-morph'

const CONTROLS = new Set([
  'bindQuery',
  'dispose',
  'suspend',
  'resume',
  'dehydrate',
  'waitForIdle',
  'applyDehydratedEntry',
  '__debug',
])

// `--after`: the tree already resolves the 1.0 `Root` (a handle with `api`),
// so a leftover `root.feed` is an access to a name the handle lacks.
const AFTER = process.argv.includes('--after')
const AFTER_CONTROLS = new Set([
  'api',
  'bindQuery',
  'inject',
  'dispose',
  'suspend',
  'resume',
  'dehydrate',
  'hydrate',
  'waitForIdle',
  'debug',
])

function isOldRoot(type: Type): boolean {
  const t = type.getNonNullableType()
  if (AFTER) {
    return (
      t.getProperty('api') !== undefined &&
      t.getProperty('waitForIdle') !== undefined &&
      t.getProperty('debug') !== undefined &&
      t.getProperty('hydrate') !== undefined
    )
  }
  return (
    t.getProperty('__debug') !== undefined &&
    t.getProperty('waitForIdle') !== undefined &&
    t.getProperty('applyDehydratedEntry') !== undefined
  )
}

const isControl = (name: string): boolean =>
  AFTER ? AFTER_CONTROLS.has(name) || name === '__debug' : CONTROLS.has(name)

const LHS_KINDS = new Set([
  SyntaxKind.Identifier,
  SyntaxKind.CallExpression,
  SyntaxKind.PropertyAccessExpression,
  SyntaxKind.ElementAccessExpression,
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.ThisKeyword,
])

type Edit = { start: number; end: number; text: string }

/** Append `.api` to an expression, parenthesizing it when precedence needs it. */
function apiAfter(expr: Node): Edit[] {
  if (LHS_KINDS.has(expr.getKind()))
    return [{ start: expr.getEnd(), end: expr.getEnd(), text: '.api' }]
  return [
    { start: expr.getStart(), end: expr.getStart(), text: '(' },
    { start: expr.getEnd(), end: expr.getEnd(), text: ').api' },
  ]
}

const manual: string[] = []
let total = 0
const seen = new Set<string>()

for (const tsconfig of process.argv.slice(2).filter((a) => !a.startsWith('--'))) {
  const project = new Project({ tsConfigFilePath: tsconfig })
  for (const file of project.getSourceFiles()) {
    const path = file.getFilePath()
    if (path.includes('/node_modules/') || path.includes('/dist/') || seen.has(path)) continue
    seen.add(path)
    const edits: Edit[] = []

    for (const pae of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const target = pae.getExpression()
      if (!isOldRoot(target.getType())) continue
      const name = pae.getName()
      if (name === '__debug') {
        const n = pae.getNameNode()
        edits.push({ start: n.getStart(), end: n.getEnd(), text: 'debug' })
      } else if (!isControl(name)) {
        edits.push(...apiAfter(target))
      }
    }

    for (const decl of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const nameNode = decl.getNameNode()
      const init = decl.getInitializer()
      if (init === undefined || !nameNode.isKind(SyntaxKind.ObjectBindingPattern)) continue
      if (!isOldRoot(init.getType())) continue
      const names = nameNode
        .getElements()
        .map((el) => el.getPropertyNameNode()?.getText() ?? el.getName())
      if (names.every((n) => !isControl(n))) edits.push(...apiAfter(init))
      else manual.push(`${path}:${decl.getStartLineNumber()} destructures root controls and api`)
    }

    for (const spread of file.getDescendantsOfKind(SyntaxKind.SpreadAssignment)) {
      if (isOldRoot(spread.getExpression().getType())) {
        manual.push(`${path}:${spread.getStartLineNumber()} spreads a root`)
      }
    }

    if (edits.length === 0) continue
    let text = file.getFullText()
    edits.sort((a, b) => b.start - a.start || b.end - a.end)
    for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end)
    file.replaceWithText(text)
    file.saveSync()
    total += edits.length
    console.log(`[root-api] ${edits.length.toString().padStart(4)} ${path}`)
  }
}

console.log(`[root-api] ${total} edits`)
for (const m of manual) console.log(`[root-api] MANUAL ${m}`)
