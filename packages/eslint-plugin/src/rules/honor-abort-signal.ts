import { ASTUtils, type TSESTree } from '@typescript-eslint/utils'
import { type AnyFunction, calleeName, createRule, isFunction } from '../utils'

type MessageId = 'missing' | 'notTaken' | 'unused'
/** What to report, or `undefined` when the function honors its signal. */
type Finding = { messageId: MessageId; node: TSESTree.Node } | undefined

/** A function the engine hands an `AbortSignal`, and where its context parameter sits. */
type Site = { fn: AnyFunction; index: number; name: 'fetcher' | 'mutate' }

/** A property key as a string: `a`, `'a'`, `['a']`. `undefined` for a computed key that is not a literal. */
function keyName(key: TSESTree.Node, computed: boolean): string | undefined {
  if (key.type === 'Literal') return String(key.value)
  if (key.type === 'Identifier' && !computed) return key.name
  return undefined
}

/** The value of `obj.<name>` when `obj` is an object literal and the value is a function written in place. */
function functionProperty(obj: TSESTree.Node | undefined, name: string): AnyFunction | undefined {
  if (obj?.type !== 'ObjectExpression') return undefined
  let found: AnyFunction | undefined
  for (const prop of obj.properties) {
    if (prop.type !== 'Property' || keyName(prop.key, prop.computed) !== name) continue
    // The last one wins, as it does at runtime.
    found = isFunction(prop.value) ? prop.value : undefined
  }
  return found
}

function siteOf(call: TSESTree.CallExpression): Site | undefined {
  const [first, second] = call.arguments
  let fn: AnyFunction | undefined
  switch (calleeName(call)) {
    case 'defineQuery':
    case 'defineInfiniteQuery':
      fn = functionProperty(first, 'fetcher')
      return fn && { fn, index: 0, name: 'fetcher' }
    case 'defineMutation':
      fn = functionProperty(first, 'mutate')
      return fn && { fn, index: 1, name: 'mutate' }
    case 'createMutation':
      // `createMutation(ctx, spec)`. In `createMutation(ctx, def, hooks)` the
      // second argument is a name, and its `mutate` is checked at `defineMutation`.
      fn = functionProperty(second, 'mutate')
      return fn && { fn, index: 1, name: 'mutate' }
    case 'createCache':
      return isFunction(second) ? { fn: second, index: 0, name: 'fetcher' } : undefined
    default:
      return undefined
  }
}

const unwrapDefault = (node: TSESTree.Node): TSESTree.Node =>
  node.type === 'AssignmentPattern' ? node.left : node

/**
 * A request that ignores its `AbortSignal` runs to completion after the
 * engine has given up on it. The engine drops a superseded fetch's result and
 * races `mutate` against the signal, so the state stays right, but the
 * request still costs the network and the server its full price. A
 * `latest-wins` search sends every keystroke's query to the end.
 *
 * Syntax can see whether `signal` is taken from the context and read. It
 * cannot see into a helper, so passing the whole context on counts as a use.
 */
export const honorAbortSignal = createRule<[{ ignorePattern: string }], MessageId>({
  name: 'honor-abort-signal',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Require a `fetcher` or `mutate` to read the `signal` from its context, so a cancelled request stops.',
    },
    messages: {
      missing:
        'This `{{name}}` does not take its context, so it cannot pass `signal` on. Take ' +
        '`{ signal }` and pass it to the request, so a cancelled run stops its request.',
      notTaken:
        'This `{{name}}` takes its context but does not read `signal` from it. Pass `signal` ' +
        'to the request, or the whole context to a helper, so a cancelled run stops its request.',
      unused:
        '`signal` is destructured and never used. Pass it to the request, so a cancelled run ' +
        'stops its request.',
    },
    schema: [
      {
        type: 'object',
        properties: { ignorePattern: { type: 'string' } },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ ignorePattern: '^_' }],
  create(context, [options]) {
    const source = context.sourceCode
    const ignored = new RegExp(options.ignorePattern)

    const references = (id: TSESTree.Identifier) =>
      ASTUtils.findVariable(source.getScope(id), id)?.references ?? []

    /** `{ signal, ...rest }`: is `signal` read, directly or through `rest`? */
    const patternFinding = (pattern: TSESTree.ObjectPattern): Finding => {
      let rest: TSESTree.RestElement | undefined
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') {
          rest = prop
          continue
        }
        const key = keyName(prop.key, prop.computed)
        // A computed key could be `signal`; syntax cannot tell.
        if (key === undefined) return undefined
        if (key !== 'signal') continue
        const value = unwrapDefault(prop.value)
        // `{ signal: { aborted } }` reads the signal in a nested pattern.
        if (value.type !== 'Identifier' || ignored.test(value.name)) return undefined
        return references(value).some((r) => r.isRead())
          ? undefined
          : { messageId: 'unused', node: value }
      }
      if (rest?.argument.type === 'Identifier') return identifierFinding(rest.argument)
      return { messageId: 'notTaken', node: pattern }
    }

    /**
     * `ctx`: is `ctx.signal` read, or the whole object passed on? `ctx.deps`
     * alone is not a use; `helper(ctx)`, `{ ...ctx }` and `ctx[key]` are.
     */
    const identifierFinding = (id: TSESTree.Identifier): Finding => {
      if (ignored.test(id.name)) return undefined
      let finding: Finding = { messageId: 'notTaken', node: id }
      for (const ref of references(id)) {
        if (!ref.isRead()) continue
        const parent = ref.identifier.parent
        if (parent.type === 'MemberExpression' && parent.object === ref.identifier) {
          const key = keyName(parent.property, parent.computed)
          if (key === undefined || key === 'signal') return undefined
          continue
        }
        if (parent.type === 'VariableDeclarator' && parent.id.type === 'ObjectPattern') {
          // `const { signal } = ctx`
          const inner = patternFinding(parent.id)
          if (inner === undefined) return undefined
          if (inner.messageId === 'unused') finding = inner
          continue
        }
        return undefined
      }
      return finding
    }

    /** A non-arrow function can reach its context through `arguments`. */
    const readsArguments = (fn: AnyFunction): boolean =>
      fn.type !== 'ArrowFunctionExpression' &&
      (source.getScope(fn).set.get('arguments')?.references.length ?? 0) > 0

    const findingOf = ({ fn, index }: Site): Finding => {
      for (const param of fn.params.slice(0, index + 1)) {
        // `(...args)` or `(vars, ...rest)`: the rest holds the context, and any
        // read of it (`helper(...args)`, `args[0]`) can reach the signal.
        if (param.type !== 'RestElement') continue
        const rest = param.argument
        if (rest.type !== 'Identifier' || ignored.test(rest.name)) return undefined
        return references(rest).some((r) => r.isRead())
          ? undefined
          : { messageId: 'notTaken', node: param }
      }
      const param = fn.params[index]
      if (param === undefined) {
        return readsArguments(fn) ? undefined : { messageId: 'missing', node: fn }
      }
      const ctx = unwrapDefault(param)
      if (ctx.type === 'Identifier') return identifierFinding(ctx)
      if (ctx.type === 'ObjectPattern') return patternFinding(ctx)
      return undefined
    }

    return {
      CallExpression(node) {
        const site = siteOf(node)
        if (site === undefined) return
        const finding = findingOf(site)
        if (finding === undefined) return
        const { fn } = site
        // A missing context marks the function's head, not its whole body.
        const loc =
          finding.messageId === 'missing'
            ? { start: fn.loc.start, end: fn.body.loc.start }
            : undefined
        context.report({
          node: finding.node,
          loc,
          messageId: finding.messageId,
          data: { name: site.name },
        })
      },
    }
  },
})
