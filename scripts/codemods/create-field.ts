/**
 * 1.0 codemod: `createField` takes an options bag, like `createForm` and
 * `createFieldArray`.
 *
 *   createField(ctx, '', [required()])                     → createField(ctx, '', { validators: [required()] })
 *   createField(ctx, '', [required()], { validateOn: 'blur' }) → createField(ctx, '', { validators: [required()], validateOn: 'blur' })
 *   createField(ctx, '', undefined, { validateOn: 'blur' }) → createField(ctx, '', { validateOn: 'blur' })
 *
 * Syntactic: it matches calls whose callee is written `createField`, and
 * leaves a call alone when its third argument is already an object literal.
 *
 * Usage: tsx scripts/codemods/create-field.ts <glob> [<glob> ...]
 */
import { Project, SyntaxKind } from 'ts-morph'

let total = 0
const project = new Project({ skipAddingFilesFromTsConfig: true })
for (const glob of process.argv.slice(2)) project.addSourceFilesAtPaths(glob)

for (const file of project.getSourceFiles()) {
  const path = file.getFilePath()
  if (path.includes('/node_modules/') || path.includes('/dist/')) continue
  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'createField') continue
    const args = call.getArguments()
    const validators = args[2]
    if (validators === undefined || validators.isKind(SyntaxKind.ObjectLiteralExpression)) continue
    const options = args[3]
    const parts: string[] = []
    if (validators.getText() !== 'undefined') parts.push(`validators: ${validators.getText()}`)
    if (options?.isKind(SyntaxKind.ObjectLiteralExpression)) {
      for (const p of options.getProperties()) parts.push(p.getText())
    } else if (options !== undefined) {
      parts.push(`...${options.getText()}`)
    }
    const end = (options ?? validators).getEnd()
    edits.push({ start: validators.getStart(), end, text: `{ ${parts.join(', ')} }` })
  }

  if (edits.length === 0) continue
  let text = file.getFullText()
  edits.sort((a, b) => b.start - a.start)
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end)
  file.replaceWithText(text)
  file.saveSync()
  total += edits.length
  console.log(`[create-field] ${edits.length.toString().padStart(4)} ${path}`)
}
console.log(`[create-field] ${total} edits`)
