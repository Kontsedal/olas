import type { TSESTree } from '@typescript-eslint/utils'
import { calleeName, createRule, isOlasSetData, isOnMutateHook, receiverText } from '../utils'

/**
 * The optimistic recipe (spec §6.4) is `cancel()` first, then `setData()`. A
 * fetch already in flight resolves after the patch and overwrites it. "Nothing
 * invalidates this query" is not a reason to skip the cancel: an entry also
 * fetches when a subscriber acquires it while stale, or after `resume()`.
 */
export const cancelBeforeOptimistic = createRule({
  name: 'cancel-before-optimistic',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `cancel(...)` on a query before an optimistic `setData(...)` in the same `onMutate`.',
    },
    messages: {
      missing:
        "Call '{{target}}.cancel(…)' before '{{target}}.setData(…)': a fetch in flight " +
        'would land after the optimistic write and overwrite it.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const source = context.sourceCode

    /** Receivers `cancel`led in `fn`'s body before `position`. */
    const cancelledBefore = (fn: TSESTree.Node, position: number): Set<string> => {
      const out = new Set<string>()
      const visit = (node: TSESTree.Node): void => {
        if (node.range[0] >= position) return
        if (node.type === 'CallExpression' && calleeName(node) === 'cancel') {
          const target = receiverText(node, source)
          if (target !== undefined) out.add(target)
        }
        for (const key of Object.keys(node) as Array<keyof typeof node>) {
          if (key === 'parent') continue
          const child = node[key] as unknown
          if (Array.isArray(child)) {
            for (const c of child) {
              if (c !== null && typeof c === 'object' && 'type' in c) visit(c as TSESTree.Node)
            }
          } else if (child !== null && typeof child === 'object' && 'type' in (child as object)) {
            visit(child as TSESTree.Node)
          }
        }
      }
      visit(fn)
      return out
    }

    return {
      CallExpression(node) {
        if (calleeName(node) !== 'setData' || !isOlasSetData(node)) return
        const target = receiverText(node, source)
        if (target === undefined) return
        let cursor: TSESTree.Node | null | undefined = node.parent
        while (cursor != null) {
          if (
            (cursor.type === 'ArrowFunctionExpression' || cursor.type === 'FunctionExpression') &&
            isOnMutateHook(cursor)
          ) {
            if (!cancelledBefore(cursor.body, node.range[0]).has(target)) {
              context.report({ node, messageId: 'missing', data: { target } })
            }
            return
          }
          cursor = cursor.parent
        }
      },
    }
  },
})
