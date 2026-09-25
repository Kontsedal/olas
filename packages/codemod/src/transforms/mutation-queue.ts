import { Node, SyntaxKind } from 'ts-morph'
import { runPerFile } from '../edits'
import type { Transform } from '../types'
import { functionLiteralOf, prop, renameKey } from '../util/ast'
import { refOf } from '../util/olas'
import { isOldMutationQueuePlugin } from '../util/shape'

export const REPLAY_NOW =
  '`replayNow` moved to the `MutationQueue` service in 1.0: `ctx.inject(MutationQueue).replayNow()`'
export const REPLAY_SETTLE =
  "`onReplaySettle`'s third argument is the root's `QueryHost` in 1.0, addressed by query id: `queries.invalidate('<id>', key)`"
export const ADAPTER_VARIABLE = 'rename `adapter` to `storage` in the options this passes'

/** `mutationQueuePlugin({ adapter })` → `{ storage }`; the plugin-held `replayNow` is a service. */
export const mutationQueue: Transform = {
  name: 'mutation-queue',
  description: '`mutationQueuePlugin({ adapter })` → `mutationQueuePlugin({ storage })`',
  run: (files) =>
    runPerFile('mutation-queue', files, (file, changes) => {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const ref = refOf(call.getExpression())
        if (ref?.pkg !== 'mutation-queue' || ref.name !== 'mutationQueuePlugin') continue
        const options = call.getArguments()[0]
        if (options === undefined) continue
        if (!Node.isObjectLiteralExpression(options)) {
          if (options.getType().getProperty('adapter') !== undefined) {
            changes.todo(options, ADAPTER_VARIABLE)
          }
          continue
        }
        const adapter = prop(options, 'adapter')
        if (adapter !== undefined) {
          changes.push(renameKey(adapter, 'storage'))
          changes.site()
        }
        const settle = functionLiteralOf(prop(options, 'onReplaySettle'))
        if (settle !== undefined && settle.getParameters().length >= 3) {
          changes.todo(settle, REPLAY_SETTLE)
        }
      }
      for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getName() === 'replayNow' && isOldMutationQueuePlugin(access.getExpression())) {
          changes.todo(access, REPLAY_NOW)
        }
      }
    }),
}
