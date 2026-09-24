import { calleeName, createRule, enclosingFunctions, isControllerFactory } from '../utils'

/**
 * A controller factory runs once, when the controller is constructed, outside
 * any React render. A React hook called there (`useState`, `useEffect`, a
 * custom `useX`) has no component to attach to: it throws, or it silently binds
 * to whatever component happens to be rendering.
 */
export const noReactHooksInControllers = createRule({
  name: 'no-react-hooks-in-controllers',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow React hooks inside a `defineController` factory.',
    },
    messages: {
      hook:
        "'{{name}}' is a React hook, and a controller factory runs outside React. Build state " +
        'with `signal`/`computed` and `create*(ctx, …)`, and read it in a component with the ' +
        'olas-react hooks.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node)
        if (name === undefined || !/^use[A-Z0-9]/.test(name)) return
        if (enclosingFunctions(node).some(isControllerFactory)) {
          context.report({ node, messageId: 'hook', data: { name } })
        }
      },
    }
  },
})
