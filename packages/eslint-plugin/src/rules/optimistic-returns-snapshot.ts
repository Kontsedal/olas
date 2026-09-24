import type { TSESTree } from '@typescript-eslint/utils'
import {
  type AnyFunction,
  calleeName,
  createRule,
  enclosingFunctions,
  isOlasSetData,
  isOnMutateHook,
} from '../utils'

/** The name a function is bound to: `function f() {}` or `const f = () => {}`. */
function boundName(fn: AnyFunction): string | undefined {
  if (fn.type === 'FunctionDeclaration') return fn.id?.name
  const parent = fn.parent
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier')
    return parent.id.name
  return undefined
}

/**
 * `setData` is the optimistic write: it returns a `Snapshot`, and the mutation
 * runner rolls the patch back through it when the run fails. Two mistakes
 * follow from its shape:
 *
 * - **Inside `onMutate`, the snapshot is dropped.** The runner only rolls back
 *   what `onMutate` returns, so a failed run leaves the guess on screen and
 *   `hasPendingMutations` stuck at `true`.
 * - **Outside `onMutate`, a discarded snapshot is never settled.** A server
 *   push or a realtime fold written with `setData` leaves a live snapshot
 *   behind on every call. `write` is the canonical patch for that. A snapshot
 *   the code keeps, returns or settles on the spot (`setData(…).finalize()`,
 *   the only canonical patch a `LocalCache` has) is managed, and passes.
 *
 * A function passed by name (`onMutate: applyOptimistic`) counts as the hook.
 */
export const optimisticReturnsSnapshot = createRule({
  name: 'optimistic-returns-snapshot',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `onMutate` to return the `setData` snapshot, and flag a `setData` snapshot discarded outside `onMutate`.',
    },
    messages: {
      dropped:
        'This snapshot is dropped. Return it from `onMutate` (or return an array of snapshots) ' +
        'so the runner can roll the optimistic write back when the run fails.',
      outside:
        'This `setData` snapshot is discarded outside `onMutate`, so nothing settles it and ' +
        '`hasPendingMutations` stays true. Use `write` for a canonical patch, `replace` for a ' +
        'whole value, or settle the snapshot with `.finalize()`.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    /** Names used as an `onMutate` value somewhere in the file. */
    const hookNames = new Set<string>()
    const calls: Array<{ node: TSESTree.CallExpression; fns: AnyFunction[] }> = []

    /** Is the call's result used: returned, assigned, passed or put in an array? */
    const resultIsUsed = (node: TSESTree.CallExpression): boolean => {
      const parent = node.parent
      if (parent == null) return false
      if (parent.type === 'ExpressionStatement') return false
      if (parent.type === 'UnaryExpression' && parent.operator === 'void') return false
      return true
    }

    return {
      Property(node) {
        const isOnMutate =
          (node.key.type === 'Identifier' && node.key.name === 'onMutate') ||
          (node.key.type === 'Literal' && node.key.value === 'onMutate')
        if (isOnMutate && node.value.type === 'Identifier') hookNames.add(node.value.name)
      },
      CallExpression(node) {
        if (calleeName(node) !== 'setData' || !isOlasSetData(node)) return
        calls.push({ node, fns: enclosingFunctions(node) })
      },
      'Program:exit'() {
        for (const { node, fns } of calls) {
          const isHook = (fn: AnyFunction): boolean => {
            if (isOnMutateHook(fn)) return true
            const name = boundName(fn)
            return name !== undefined && hookNames.has(name)
          }
          if (resultIsUsed(node)) continue
          context.report({ node, messageId: fns.some(isHook) ? 'dropped' : 'outside' })
        }
      },
    }
  },
})
