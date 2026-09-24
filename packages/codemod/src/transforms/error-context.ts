import { Node, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform } from '../types'
import { isErrorContext, isOldDisposedError } from '../util/shape'

const RENAMED: ReadonlyArray<{
  from: string
  to: string
  owner: (node: Node) => boolean
}> = [
  // 0.8's `queryKey` held the entry's key args, which is what 1.0 calls `key`.
  { from: 'queryKey', to: 'key', owner: isErrorContext },
  { from: 'mutationName', to: 'mutationId', owner: isOldDisposedError },
]

function visitDestructuring(changes: FileChanges): void {
  for (const element of changes.file.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const pattern = element.getParent()
    if (!Node.isObjectBindingPattern(pattern)) continue
    const key = element.getPropertyNameNode()
    const name = key?.getText() ?? element.getName()
    const rule = RENAMED.find((r) => r.from === name)
    if (rule === undefined || !rule.owner(pattern)) continue
    if (key !== undefined) changes.replaceNode(key, rule.to)
    else changes.replaceNode(element.getNameNode(), `${rule.to}: ${name}`)
    changes.site()
  }
}

/** `ErrorContext.queryKey` → `key`; `MutationDisposedError.mutationName` → `mutationId`. */
export const errorContext: Transform = {
  name: 'error-context',
  description:
    '`ErrorContext.queryKey` → `key`; `MutationDisposedError.mutationName` → `mutationId`',
  run: (files) =>
    runPerFile('error-context', files, (file, changes) => {
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const rule = RENAMED.find((r) => r.from === access.getName())
        if (rule === undefined || !rule.owner(access.getExpression())) continue
        changes.replaceNode(access.getNameNode(), rule.to)
        changes.site()
      }
      visitDestructuring(changes)
    }),
}
