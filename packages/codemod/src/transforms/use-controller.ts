import { Node } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { accessText, localReferences, removeImportSpecifier } from '../util/ast'
import { importsOf, localNameOf } from '../util/olas'

export const USE_CONTROLLER =
  '`useController` is removed: it returned the root it was given, and `root.api` says the same thing'

/**
 * `useController(root)` was an identity function over the root, typed as its
 * api. 1.0 removes it; the api is `root.api`. This runs after `root-api`, so
 * the `.api` it writes is not taken for an api member.
 */
export const useController: Transform = {
  name: 'use-controller',
  description: '`useController(root)` → `root.api`',
  run: (files) =>
    runPerFile('use-controller', files, (file, changes) => {
      for (const spec of importsOf(file, 'react', 'useController')) {
        let removable = true
        for (const ref of localReferences(localNameOf(spec))) {
          const call = ref.getParentOrThrow()
          if (
            !Node.isCallExpression(call) ||
            call.getExpression() !== ref ||
            call.getArguments().length !== 1
          ) {
            removable = false
            changes.todo(ref, USE_CONTROLLER)
            continue
          }
          changes.replaceNode(call, accessText(call.getArguments()[0] as Node, 'api'))
          changes.site()
        }
        if (removable) changes.push(removeImportSpecifier(spec))
      }
    }),
}
