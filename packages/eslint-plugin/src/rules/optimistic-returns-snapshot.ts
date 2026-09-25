import type { TSESTree } from '@typescript-eslint/utils'
import {
  type AnyFunction,
  calleeName,
  createRule,
  enclosingFunctions,
  isOlasSetData,
  onMutateHooks,
  valueParent,
} from '../utils'

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
    const hooks = onMutateHooks()
    const calls: Array<{ node: TSESTree.CallExpression; fns: AnyFunction[] }> = []

    /**
     * Is the call's result used: returned, assigned, passed or put in an
     * array? Judged past the wrappers that keep the value, so the
     * `ChainExpression` around `todos?.setData(fn)` is not a use.
     */
    const resultIsUsed = (node: TSESTree.CallExpression): boolean => {
      const parent = valueParent(node)
      if (parent == null) return false
      if (parent.type === 'ExpressionStatement') return false
      if (parent.type === 'UnaryExpression' && parent.operator === 'void') return false
      return true
    }

    return {
      Property: hooks.Property,
      CallExpression(node) {
        if (calleeName(node) !== 'setData' || !isOlasSetData(node)) return
        calls.push({ node, fns: enclosingFunctions(node) })
      },
      'Program:exit'() {
        for (const { node, fns } of calls) {
          if (resultIsUsed(node)) continue
          context.report({ node, messageId: fns.some(hooks.isHook) ? 'dropped' : 'outside' })
        }
      },
    }
  },
})
