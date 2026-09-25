import { calleeName, createRule, isFunction } from '../utils'

/**
 * `createRoot` and `ctx.child` use the factory's return value as the
 * controller's api at once. An `async` factory returns a promise, so the api is
 * a promise, every `ctx.*` call after the first `await` runs after
 * construction finished, and its lifetime bookkeeping is wrong. Load data with
 * a query and let the controller expose the subscription.
 */
export const noAsyncControllerFactory = createRule({
  name: 'no-async-controller-factory',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow an `async` factory in `defineController`.',
    },
    messages: {
      async:
        'A controller factory must be synchronous: its return value is the api. Load data ' +
        'with `createQuery(ctx, …)` and expose the subscription instead of awaiting it.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (calleeName(node) !== 'defineController') return
        const factory = node.arguments[0]
        if (isFunction(factory) && factory.async) {
          context.report({ node: factory, messageId: 'async' })
        }
      },
    }
  },
})
