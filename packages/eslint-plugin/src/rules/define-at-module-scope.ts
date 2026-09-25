import { calleeName, createRule, enclosingFunction } from '../utils'

// The definitions whose identity the engine keys on. `defineController` and
// `definePlugin` are left out on purpose: a controller def built inside a
// root-composition function, or a plugin built by a factory that takes
// options, is the documented pattern, and neither is looked up by identity.
const DEFINERS = new Set(['defineQuery', 'defineInfiniteQuery', 'defineMutation', 'defineScope'])

/**
 * Definitions are identities. A `defineQuery` inside a function mints a new
 * query on every call, so two controllers that meant to share a cache entry
 * each get their own, and the second one's id collides with the first in the
 * root. A `defineScope` inside a function makes a scope nobody else can
 * `inject`. A `defineMutation` inside a function re-registers its id on
 * every call.
 */
export const defineAtModuleScope = createRule({
  name: 'define-at-module-scope',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require `defineQuery`, `defineInfiniteQuery`, `defineMutation` and `defineScope` at module scope.',
    },
    messages: {
      nested:
        "'{{name}}' is called inside a function, so every call makes a new definition with its " +
        'own identity. Move it to module scope.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node)
        if (name === undefined || !DEFINERS.has(name)) return
        if (enclosingFunction(node) !== undefined) {
          context.report({ node, messageId: 'nested', data: { name } })
        }
      },
    }
  },
})
