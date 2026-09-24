import { type CallExpression, Node, SyntaxKind } from 'ts-morph'
import { type FileChanges, runPerFile } from '../edits'
import type { Transform } from '../types'
import { isJsxHandlerBody, localReferences, resultUse } from '../util/ast'
import { isOldUseMutation } from '../util/shape'

export const MUTATE_RETURNED =
  "0.8's `mutate` returned the run's promise and 1.0's returns nothing: call `run` here if the caller waits for the result"
export const MUTATE_DESTRUCTURED =
  'this reads the result of `mutate`, which returns nothing in 1.0: destructure `run` and call it here'

/**
 * What a `mutate(...)` call needs, given how its result is consumed. A
 * statement keeps `mutate`: it is fire-and-forget in 1.0, and a failure goes
 * to the mutation's state instead of an unhandled rejection.
 */
function mutateCall(call: CallExpression): 'keep' | 'run' | 'todo' {
  const use = resultUse(call)
  if (use === 'unused') return 'keep'
  if (use === 'returned') return isJsxHandlerBody(call) ? 'keep' : 'todo'
  return 'run'
}

function visitDestructuring(changes: FileChanges): void {
  for (const element of changes.file.getDescendantsOfKind(SyntaxKind.BindingElement)) {
    const pattern = element.getParent()
    const decl = pattern.getParent()
    if (!Node.isVariableDeclaration(decl) || !Node.isObjectBindingPattern(pattern)) continue
    const init = decl.getInitializer()
    if (init === undefined || !isOldUseMutation(init)) continue
    const key = element.getPropertyNameNode()
    const name = key?.getText() ?? element.getName()
    if (name === 'mutateAsync') {
      if (key !== undefined) changes.replaceNode(key, 'run')
      else changes.replaceNode(element.getNameNode(), 'run: mutateAsync')
      changes.site()
    } else if (name === 'mutate') {
      for (const ref of localReferences(element.getNameNode())) {
        const call = ref.getParent()
        if (!Node.isCallExpression(call) || call.getExpression() !== ref) continue
        const need = mutateCall(call)
        if (need === 'run') changes.todo(call, MUTATE_DESTRUCTURED)
        else if (need === 'todo') changes.todo(call, MUTATE_RETURNED)
      }
    }
  }
}

/**
 * `useMutation` returns `mutate` and `run` in 1.0. `mutateAsync` becomes
 * `run`. A `mutate(...)` whose promise the code waits on or passes along
 * becomes `run(...)` too, since 1.0's `mutate` returns nothing.
 */
export const reactMutation: Transform = {
  name: 'react-mutation',
  description:
    '`useMutation`: `mutateAsync` → `run`; a `mutate(...)` whose promise is used → `run(...)`',
  run: (files) =>
    runPerFile('react-mutation', files, (file, changes) => {
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        const name = access.getName()
        if (name !== 'mutate' && name !== 'mutateAsync') continue
        if (!isOldUseMutation(access.getExpression())) continue
        if (name === 'mutateAsync') {
          changes.replaceNode(access.getNameNode(), 'run')
          changes.site()
          continue
        }
        const call = access.getParent()
        if (!Node.isCallExpression(call) || call.getExpression() !== access) continue
        const need = mutateCall(call)
        if (need === 'run') {
          changes.replaceNode(access.getNameNode(), 'run')
          changes.site()
        } else if (need === 'todo') {
          changes.todo(call, MUTATE_RETURNED)
        }
      }
      visitDestructuring(changes)
    }),
}
