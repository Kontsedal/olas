import type { TSESTree } from '@typescript-eslint/utils'
import {
  calleeName,
  createRule,
  enclosingFunctions,
  isOlasSetData,
  onMutateHooks,
  receiverText,
} from '../utils'

/** The calls that cancel a query's fetches: `cancel(...keyArgs)` and `cancelAll()` (spec §5.7). */
const CANCELS = new Set(['cancel', 'cancelAll'])

/**
 * The optimistic recipe (spec §6.4) is `cancel()` first, then `setData()`. A
 * fetch already in flight resolves after the patch and overwrites it. "Nothing
 * invalidates this query" is not a reason to skip the cancel: an entry also
 * fetches when a subscriber acquires it while stale, or after `resume()`.
 *
 * A function passed by name (`onMutate: applyOptimistic`) counts as the hook.
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
    const hooks = onMutateHooks()
    const writes: TSESTree.CallExpression[] = []

    /** Receivers cancelled in `fn`'s body before `position`. */
    const cancelledBefore = (fn: TSESTree.Node, position: number): Set<string> => {
      const out = new Set<string>()
      const visit = (node: TSESTree.Node): void => {
        if (node.range[0] >= position) return
        if (node.type === 'CallExpression' && CANCELS.has(calleeName(node) ?? '')) {
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
      Property: hooks.Property,
      CallExpression(node) {
        if (calleeName(node) === 'setData' && isOlasSetData(node)) writes.push(node)
      },
      'Program:exit'() {
        for (const node of writes) {
          const target = receiverText(node, source)
          const hook = enclosingFunctions(node).find(hooks.isHook)
          if (target === undefined || hook === undefined) continue
          if (!cancelledBefore(hook.body, node.range[0]).has(target)) {
            context.report({ node, messageId: 'missing', data: { target } })
          }
        }
      },
    }
  },
})
