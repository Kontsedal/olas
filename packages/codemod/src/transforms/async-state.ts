import { SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { isOldAsyncState } from '../util/shape'

/** `AsyncState.promise()` was an alias of `firstValue()`, and 1.0 removes it. */
export const asyncState: Transform = {
  name: 'async-state',
  description: '`subscription.promise()` → `subscription.firstValue()`',
  run: (files) =>
    runPerFile('async-state', files, (file, changes) => {
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getName() !== 'promise' || !isOldAsyncState(access.getExpression())) continue
        changes.replaceNode(access.getNameNode(), 'firstValue')
        changes.site()
      }
    }),
}
