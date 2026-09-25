import type { TSESTree } from '@typescript-eslint/utils'
import { createRule } from '../utils'

const TESTING = '@kontsedal/olas-core/testing'

/** What counts as a test file when the `testFiles` option is not set. */
const DEFAULT_TEST_FILES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.test-d.*',
  '**/tests/**',
  '**/test/**',
  '**/__tests__/**',
]

/**
 * A glob as a regular expression over a `/`-separated path. `**` matches any
 * number of directories, `*` and `?` match within one path segment, and
 * `{a,b}` matches either branch.
 */
export function globToRegExp(glob: string): RegExp {
  let out = ''
  let inBraces = false
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '*' && glob[i + 1] === '*') {
      const segmentStart = i === 0 || glob[i - 1] === '/'
      if (segmentStart && glob[i + 2] === '/') {
        out += '(?:.*/)?'
        i += 2
      } else {
        out += '.*'
        i += 1
      }
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else if (c === '{') {
      out += '(?:'
      inBraces = true
    } else if (c === '}' && inBraces) {
      out += ')'
      inBraces = false
    } else if (c === ',' && inBraces) out += '|'
    else out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** `file` relative to `cwd`, with `/` separators. A file outside `cwd` keeps its full path. */
function relativeTo(file: string, cwd: string): string {
  const path = file.replace(/\\/g, '/')
  const base = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  // Windows paths differ in drive-letter case between tools.
  return path.toLowerCase().startsWith(`${base.toLowerCase()}/`)
    ? path.slice(base.length + 1)
    : path
}

/** The module a static import names: `'x'` or `` `x` ``. */
function moduleName(node: TSESTree.Node | null | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  // `cooked` is `null` for a template with an invalid escape.
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

/**
 * `@kontsedal/olas-core/testing` holds `createTestController`, the plugin
 * recorder, `mockFetchPlugin` and the mutation-registry teardown. It is a
 * separate sub-path so that an import of it is easy to find. Imported from
 * app code, it ships test helpers to users, and a mock plugin or a registry
 * teardown there changes what the app does.
 *
 * An `import type` is erased at build time and passes.
 */
export const noTestingOutsideTests = createRule<[{ testFiles: string[] }], 'outside'>({
  name: 'no-testing-outside-tests',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow importing `@kontsedal/olas-core/testing` outside test files.',
    },
    messages: {
      outside:
        "'@kontsedal/olas-core/testing' is for tests, and this file matches none of the " +
        "rule's `testFiles` patterns. Import it from a test file, or add this file to `testFiles`.",
    },
    schema: [
      {
        type: 'object',
        properties: { testFiles: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{ testFiles: DEFAULT_TEST_FILES }],
  create(context, [options]) {
    const file = relativeTo(context.filename, context.cwd)
    if (options.testFiles.some((glob) => globToRegExp(glob).test(file))) return {}

    const check = (node: TSESTree.Node, source: TSESTree.Node | null | undefined): void => {
      if (moduleName(source) === TESTING) context.report({ node, messageId: 'outside' })
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind !== 'type') check(node, node.source)
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type') check(node, node.source)
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind !== 'type') check(node, node.source)
      },
      ImportExpression(node) {
        check(node, node.source)
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          check(node, node.arguments[0])
        }
      },
    }
  },
})
