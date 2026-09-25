import { Node, SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { prop, renameKey } from '../util/ast'
import { isOldRoot } from '../util/shape'

export const MAX_IDLE_VARIABLE = 'rename `maxIdle` to `maxIdleTime` in the options this passes'

/** Every duration option in 1.0 is named for its unit role: `maxIdle` → `maxIdleTime`. */
export const suspendOptions: Transform = {
  name: 'suspend-options',
  description: '`root.suspend({ maxIdle })` → `root.suspend({ maxIdleTime })`',
  run: (files) =>
    runPerFile('suspend-options', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression()
        if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'suspend') continue
        const options = call.getArguments()[0]
        if (options === undefined || !isOldRoot(callee.getExpression())) continue
        if (Node.isObjectLiteralExpression(options)) {
          const maxIdle = prop(options, 'maxIdle')
          if (maxIdle === undefined) continue
          changes.push(renameKey(maxIdle, 'maxIdleTime'))
          changes.site()
        } else if (options.getType().getProperty('maxIdle') !== undefined) {
          changes.todo(options, MAX_IDLE_VARIABLE)
        }
      }
    }),
}
