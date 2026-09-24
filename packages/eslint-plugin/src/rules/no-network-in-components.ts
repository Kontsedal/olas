import type { TSESTree } from '@typescript-eslint/utils'
import { calleeName, createRule, enclosingFunctions } from '../utils'

const NETWORK = new Set(['fetch', 'axios'])
/** Objects a global `fetch` is reached through. */
const GLOBALS = new Set(['window', 'globalThis', 'self'])

/** A function named in PascalCase, the way React components are. */
function componentName(fn: TSESTree.Node): string | undefined {
  if (fn.type === 'FunctionDeclaration') return fn.id?.name
  const parent = fn.parent
  if (parent?.type === 'VariableDeclarator' && parent.id.type === 'Identifier')
    return parent.id.name
  return undefined
}

/**
 * Opt-in. In an Olas app, a component reads state a controller owns; it does
 * not own data lifetime. A `fetch` in a component duplicates what a query does
 * (cache, dedupe, race protection, SSR) and moves the request out of the
 * controller tree, where tests without a renderer cannot reach it.
 */
export const noNetworkInComponents = createRule({
  name: 'no-network-in-components',
  meta: {
    type: 'suggestion',
    docs: {
      description: 'Disallow `fetch` / `axios` calls inside React components (opt-in).',
    },
    messages: {
      network:
        "'{{name}}' inside component '{{component}}'. Fetch in a controller with " +
        '`createQuery` or `createMutation`, and read the result with the olas-react hooks.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node)
        const root = node.callee.type === 'MemberExpression' ? node.callee.object : node.callee
        // `axios.get(…)` is named by its object; `window.fetch(…)` by its method.
        const base = root.type === 'Identifier' && !GLOBALS.has(root.name) ? root.name : name
        if (base === undefined || !NETWORK.has(base)) return
        for (const fn of enclosingFunctions(node)) {
          const component = componentName(fn)
          if (component !== undefined && /^[A-Z]/.test(component)) {
            context.report({ node, messageId: 'network', data: { name: base, component } })
            return
          }
        }
      },
    }
  },
})
