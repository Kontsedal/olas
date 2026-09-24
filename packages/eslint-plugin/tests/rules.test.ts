import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, expect, it } from 'vitest'
import plugin, { rules } from '../src'
import { globToRegExp } from '../src/rules/no-testing-outside-tests'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({
  languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
})

tester.run('no-react-hooks-in-controllers', rules['no-react-hooks-in-controllers'], {
  valid: [
    'const c = defineController((ctx) => ({ n: signal(0) }))',
    'function View() { const api = useRoot(); return useValue(api.n) }',
    // A hook in a component defined in the same module is fine.
    'const c = defineController(() => ({})); function V() { useState(0) }',
    // A call with no name, and a factory passed by reference, are left alone.
    'defineController((ctx) => { getHook()(); return {} })',
    'defineController(factory)',
    // `user` is not a hook name: `use` must be followed by a capital or a digit.
    'defineController((ctx) => ({ n: user(ctx) }))',
  ],
  invalid: [
    {
      code: 'const c = defineController((ctx) => { const [x] = useState(0); return { x } })',
      errors: [{ messageId: 'hook', data: { name: 'useState' } }],
    },
    {
      code: 'defineController((ctx) => { ctx.effect(() => { useEffect(() => {}) }); return {} })',
      errors: [{ messageId: 'hook' }],
    },
    {
      code: 'defineController(function (ctx) { return React.useMemo(() => 1, []) })',
      errors: [{ messageId: 'hook', data: { name: 'useMemo' } }],
    },
  ],
})

tester.run('define-at-module-scope', rules['define-at-module-scope'], {
  valid: [
    "export const user = defineQuery({ id: 'user', key: () => [], fetcher })",
    "const Theme = defineScope({ name: 'theme' })",
    'export const app = defineController((ctx) => ({}))',
    "export const feed = olas.defineInfiniteQuery({ id: 'feed', key: () => [], fetcher })",
    // A controller def in a root-composition function, and a plugin built by a
    // factory that takes options, are the documented patterns.
    'function createAppRoot(api) { const app = defineController((ctx) => ({})); return createRoot(app, { deps: { api } }) }',
    "export function logger(opts) { return definePlugin({ name: 'logger', setup() {} }) }",
  ],
  invalid: [
    {
      code: "function load() { const q = defineQuery({ id: 'x', key: () => [], fetcher }); return q }",
      errors: [{ messageId: 'nested', data: { name: 'defineQuery' } }],
    },
    {
      code: "defineController((ctx) => { const s = defineScope({ name: 'x' }); return {} })",
      errors: [{ messageId: 'nested', data: { name: 'defineScope' } }],
    },
    {
      code: "const make = () => defineMutation({ id: 'm', mutate })",
      errors: [{ messageId: 'nested', data: { name: 'defineMutation' } }],
    },
    {
      code: "function feed() { return olas.defineInfiniteQuery({ id: 'f', key: () => [], fetcher }) }",
      errors: [{ messageId: 'nested', data: { name: 'defineInfiniteQuery' } }],
    },
  ],
})

tester.run('no-async-controller-factory', rules['no-async-controller-factory'], {
  valid: [
    'defineController((ctx) => ({}))',
    'defineController(function (ctx) { return {} })',
    // An async helper inside the factory is fine.
    'defineController((ctx) => ({ save: async () => {} }))',
    'defineController(makeFactory())',
    'other(async () => ({}))',
  ],
  invalid: [
    { code: 'defineController(async (ctx) => ({}))', errors: [{ messageId: 'async' }] },
    { code: 'olas.defineController(async () => ({}))', errors: [{ messageId: 'async' }] },
    {
      code: 'defineController(async function (ctx) { await x; return {} })',
      errors: [{ messageId: 'async' }],
    },
  ],
})

tester.run('optimistic-returns-snapshot', rules['optimistic-returns-snapshot'], {
  valid: [
    'createMutation(ctx, def, { onMutate: (v) => todos.setData((p) => [...p, v]) })',
    'createMutation(ctx, def, { onMutate(v) { todos.cancel(); return todos.setData((p) => p) } })',
    'createMutation(ctx, def, { onMutate: (v) => [a.setData((p) => p), b.setData((p) => p)] })',
    // A named helper passed as the hook counts as the hook.
    'function apply(v) { return todos.setData((p) => p) }\ncreateMutation(ctx, def, { onMutate: apply })',
    // DataTransfer.setData is not an Olas write.
    "function onDragStart(e) { e.dataTransfer.setData('text/plain', id) }",
    // The canonical patch is fine anywhere.
    'realtime.on((e) => todos.write((p) => fold(p, e)))',
    // A snapshot kept or settled on the spot is managed by the caller.
    'realtime.on((e) => { const snap = todos.setData((p) => fold(p, e)); later(snap) })',
    'function add(c) { comments.setData((p) => [c, ...p]).finalize() }',
    // A quoted key is the same hook.
    "createMutation(ctx, def, { 'onMutate': (v) => todos.setData((p) => p) })",
    // Not an Olas write: a plain call, or no updater function last.
    'setData(1, () => 2)',
    "store.setData('k')",
  ],
  invalid: [
    {
      code: 'createMutation(ctx, def, { onMutate(v) { todos.setData((p) => p) } })',
      errors: [{ messageId: 'dropped' }],
    },
    {
      code: 'realtime.on((e) => { todos.setData((p) => fold(p, e)) })',
      errors: [{ messageId: 'outside' }],
    },
    {
      code: 'function f() { void todos.setData((p) => p) }',
      errors: [{ messageId: 'outside' }],
    },
    {
      // The helper is the hook by name, and drops the snapshot.
      code: 'function apply(v) { todos.setData((p) => p) }\ncreateMutation(ctx, def, { onMutate: apply })',
      errors: [{ messageId: 'dropped' }],
    },
    {
      code: "createMutation(ctx, def, { 'onMutate': function (v) { todos.setData((p) => p) } })",
      errors: [{ messageId: 'dropped' }],
    },
  ],
})

tester.run('cancel-before-optimistic', rules['cancel-before-optimistic'], {
  valid: [
    'createMutation(ctx, def, { onMutate(v) { todos.cancel(); return todos.setData((p) => p) } })',
    'createMutation(ctx, def, { onMutate: (v) => { list.cancel(v.id); return list.setData(v.id, (p) => p) } })',
    // Not an onMutate: out of scope for this rule.
    'function f() { todos.setData((p) => p) }',
    // The receiver is compared as written, member chains included.
    'createMutation(ctx, def, { onMutate(v) { this.q.cancel(); return this.q.setData((p) => p) } })',
    // A write inside a callback in onMutate is still after the cancel.
    'createMutation(ctx, def, { onMutate(v) { todos.cancel(); return ids.map(() => todos.setData((p) => p)) } })',
    // Not an Olas write: a plain call, and a method call with no updater.
    'createMutation(ctx, def, { onMutate: () => setData(() => 1) })',
    "createMutation(ctx, def, { onMutate: () => store.setData('k') })",
  ],
  invalid: [
    {
      code: 'createMutation(ctx, def, { onMutate: (v) => todos.setData((p) => p) })',
      errors: [{ messageId: 'missing', data: { target: 'todos' } }],
    },
    {
      code: "createMutation(ctx, def, { 'onMutate': function (v) { return getTodos().setData((p) => p) } })",
      errors: [{ messageId: 'missing', data: { target: 'getTodos()' } }],
    },
    {
      // The cancel is on another query.
      code: 'createMutation(ctx, def, { onMutate(v) { other.cancel(); return todos.setData((p) => p) } })',
      errors: [{ messageId: 'missing', data: { target: 'todos' } }],
    },
    {
      // A cancel after the write is too late.
      code: 'createMutation(ctx, def, { onMutate(v) { const s = todos.setData((p) => p); todos.cancel(); return s } })',
      errors: [{ messageId: 'missing' }],
    },
  ],
})

tester.run('no-network-in-components', rules['no-network-in-components'], {
  valid: [
    "const user = defineQuery({ id: 'u', key: () => [], fetcher: () => fetch('/u') })",
    "function loadUser() { return fetch('/u') }",
    // A method that happens to start with fetch is not the global.
    'function Profile() { return api.fetchUser() }',
    // An anonymous default export has no component name to report.
    "export default function () { fetch('/x') }",
  ],
  invalid: [
    {
      code: "function Profile() { useEffect(() => { fetch('/me') }, []); return null }",
      errors: [{ messageId: 'network', data: { name: 'fetch', component: 'Profile' } }],
    },
    {
      code: "const List = () => { axios.get('/items'); return null }",
      errors: [{ messageId: 'network', data: { name: 'axios', component: 'List' } }],
    },
    {
      code: "const Card = function () { window.fetch('/c'); return null }",
      errors: [{ messageId: 'network', data: { name: 'fetch', component: 'Card' } }],
    },
  ],
})

const Q = "id: 'u', key: () => []"

tester.run('honor-abort-signal', rules['honor-abort-signal'], {
  valid: [
    `defineQuery({ ${Q}, fetcher: ({ signal }) => fetch('/u', { signal }) })`,
    `defineInfiniteQuery({ ${Q}, fetcher: ({ pageParam, signal, deps }) => deps.api.page(pageParam, signal) })`,
    // A renamed binding, a default value, and a quoted or computed-literal key.
    "defineMutation({ id: 'm', mutate: (vars, { signal: abort }) => api.save(vars, abort) })",
    'createCache(ctx, ({ signal } = fallback) => api.get(signal))',
    `defineQuery({ ${Q}, 'fetcher': ({ ['signal']: s }) => load(s) })`,
    // The context read through its name.
    'createCache(ctx, (c) => api.get(c.signal))',
    "createCache(ctx, (c) => api.get(c['signal']))",
    'createCache(ctx, (c) => { const { signal } = c; return api.get(signal) })',
    `defineQuery({ ${Q}, fetcher(ctx) { const { deps, ...rest } = ctx; return deps.get(rest) } })`,
    // The whole context passed on counts: syntax cannot see into the helper.
    `defineQuery({ ${Q}, fetcher: (ctx, id) => getUser(ctx, id) })`,
    'createCache(ctx, (c) => { c.deps.log(); return load({ ...c }) })',
    'createCache(ctx, (c) => { const copy = c; return load(copy) })',
    'createCache(ctx, (c) => api.get(c[key]))',
    'createCache(ctx, ({ [key]: value }) => load(value))',
    'createCache(ctx, ({ deps, ...rest }) => deps.load(rest))',
    'createMutation(ctx, { mutate: (...args) => save(...args) })',
    "defineMutation({ id: 'm', mutate: (vars, ...rest) => save(vars, ...rest) })",
    `defineQuery({ ${Q}, fetcher: function () { return load.apply(null, arguments) } })`,
    // A nested pattern reads the signal; an array pattern is not a context shape.
    'createCache(ctx, ({ signal: { aborted } }) => (aborted ? null : load()))',
    'createCache(ctx, ([first]) => load(first))',
    'createCache(ctx, (...[first]) => load(first))',
    // An underscore marks work with nothing to abort.
    `defineQuery({ ${Q}, fetcher: (_ctx) => Promise.resolve(1) })`,
    "defineMutation({ id: 'm', mutate: (v, { signal: _signal }) => local(v) })",
    'createMutation(ctx, { mutate: (v, ..._rest) => local(v) })',
    'createCache(ctx, (c) => { const { signal: _s } = c; return local() })',
    { code: 'createCache(ctx, (unusedCtx) => local())', options: [{ ignorePattern: '^unused' }] },
    // A function passed by name is not followed.
    `defineQuery({ ${Q}, fetcher })`,
    "defineMutation({ id: 'm', mutate: saveTodo })",
    'createCache(ctx, loadTrades)',
    'createMutation(ctx, saveTodo, { onSuccess })',
    'defineQuery(spec)',
    // The last `fetcher` wins, as at runtime.
    `defineQuery({ ${Q}, fetcher: () => 1, fetcher: ({ signal }) => load(signal) })`,
    // Not a definer, or not the function the engine hands a signal.
    "other({ fetcher: () => fetch('/x') })",
    'createMutation(ctx, { mutate: (v, { signal }) => save(v, signal), onMutate: () => q.setData((p) => p) })',
    '(() => ({ mutate: () => 1 }))()',
  ],
  invalid: [
    {
      code: `defineQuery({ ${Q}, fetcher: () => fetch('/u') })`,
      // The report marks the head, `() => `, not the body.
      errors: [{ messageId: 'missing', data: { name: 'fetcher' }, column: 48, endColumn: 54 }],
    },
    {
      code: "defineMutation({ id: 'm', mutate: async (vars) => api.save(vars) })",
      errors: [{ messageId: 'missing', data: { name: 'mutate' } }],
    },
    {
      code: `olas.defineQuery({ ${Q}, fetcher: function () { return load() } })`,
      errors: [{ messageId: 'missing' }],
    },
    {
      code: `defineInfiniteQuery({ ${Q}, fetcher: ({ pageParam, deps }) => deps.api.page(pageParam) })`,
      errors: [{ messageId: 'notTaken', data: { name: 'fetcher' } }],
    },
    {
      code: 'createMutation(ctx, { mutate: async (vars, { signal }) => { await api.save(vars) } })',
      errors: [{ messageId: 'unused', data: { name: 'mutate' } }],
    },
    {
      code: 'createCache(ctx, (c) => c.deps.api.load())',
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: 'createCache(ctx, function (c) { return load() })',
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: 'createCache(ctx, (c = fallback) => load())',
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: 'createCache(ctx, (c) => { const { signal } = c; return load() })',
      errors: [{ messageId: 'unused' }],
    },
    {
      code: 'createCache(ctx, (c) => { const { deps } = c; return deps.load() })',
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: 'createMutation(ctx, { mutate: (vars, ...rest) => save(vars) })',
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: 'createCache(ctx, ({ deps, ...rest }) => deps.load())',
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: 'createCache(ctx, (_ctx) => load())',
      options: [{ ignorePattern: '^unused' }],
      errors: [{ messageId: 'notTaken' }],
    },
    {
      code: `defineQuery({ ${Q}, fetcher: ({ signal }) => load(signal), fetcher: () => load() })`,
      errors: [{ messageId: 'missing' }],
    },
  ],
})

const TESTING_IMPORT = "import { createTestController } from '@kontsedal/olas-core/testing'"

tester.run('no-testing-outside-tests', rules['no-testing-outside-tests'], {
  valid: [
    { code: TESTING_IMPORT, filename: 'src/app.test.ts' },
    { code: TESTING_IMPORT, filename: 'src/app.spec.tsx' },
    { code: TESTING_IMPORT, filename: 'tests/types.test-d.ts' },
    { code: TESTING_IMPORT, filename: 'packages/app/tests/helpers.ts' },
    { code: TESTING_IMPORT, filename: 'test/helpers.ts' },
    { code: TESTING_IMPORT, filename: 'src/__tests__/app.ts' },
    // An `import type` is erased at build time.
    {
      code: "import type { PluginRecorder } from '@kontsedal/olas-core/testing'",
      filename: 'src/a.ts',
    },
    {
      code: "export type { PluginRecorder } from '@kontsedal/olas-core/testing'",
      filename: 'src/a.ts',
    },
    { code: "export type * from '@kontsedal/olas-core/testing'", filename: 'src/a.ts' },
    // Other modules, and imports the rule cannot resolve.
    { code: "import { createRoot } from '@kontsedal/olas-core'", filename: 'src/a.ts' },
    { code: 'export const x = 1; const t = require(name); import(name)', filename: 'src/a.ts' },
    {
      code: "load('@kontsedal/olas-core/testing'); obj.require('@kontsedal/olas-core/testing')",
      filename: 'src/a.ts',
    },
    {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the code under test is a template literal
      code: 'import(`@kontsedal/olas-core/${sub}`)',
      filename: 'src/a.ts',
    },
    // `testFiles` names what counts as a test.
    {
      code: TESTING_IMPORT,
      filename: 'src/test-utils.ts',
      options: [{ testFiles: ['src/test-utils.ts'] }],
    },
    {
      code: TESTING_IMPORT,
      filename: 'src/Button.stories.tsx',
      options: [{ testFiles: ['**/*.{stories,fixture}.tsx'] }],
    },
    { code: TESTING_IMPORT, filename: 'e2e/a/b.ts', options: [{ testFiles: ['e2e/**'] }] },
  ],
  invalid: [
    { code: TESTING_IMPORT, filename: 'src/app.ts', errors: [{ messageId: 'outside' }] },
    {
      // An inline `type` specifier keeps the import at runtime.
      code: "import { type PluginRecorder, mockFetchPlugin } from '@kontsedal/olas-core/testing'",
      filename: 'src/app.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      code: "export * from '@kontsedal/olas-core/testing'",
      filename: 'src/index.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      code: "export { mockFetchPlugin } from '@kontsedal/olas-core/testing'",
      filename: 'src/index.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      code: "const t = import('@kontsedal/olas-core/testing')",
      filename: 'src/app.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      code: 'const t = import(`@kontsedal/olas-core/testing`)',
      filename: 'src/app.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      code: "const t = require('@kontsedal/olas-core/testing')",
      filename: 'src/app.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      // A directory is matched by whole segment: `contests` is not `tests`.
      code: TESTING_IMPORT,
      filename: 'src/contests/a.ts',
      errors: [{ messageId: 'outside' }],
    },
    {
      // `testFiles` replaces the defaults.
      code: TESTING_IMPORT,
      filename: 'src/app.test.ts',
      options: [{ testFiles: ['e2e/**'] }],
      errors: [{ messageId: 'outside' }],
    },
  ],
})

describe('globToRegExp', () => {
  it('matches whole path segments, braces and literal characters', () => {
    const cases: Array<[string, string, boolean]> = [
      ['**/tests/**', 'tests/a.ts', true],
      ['**/tests/**', 'a/b/tests/c/d.ts', true],
      ['**/tests/**', 'a/contests/d.ts', false],
      ['**/*.test.*', 'src/a.test.ts', true],
      ['**/*.test.*', 'src/a.test.dir/b.ts', false],
      ['src/**', 'src/a/b.ts', true],
      ['src/**.ts', 'src/a/b.ts', true],
      ['src/*.ts', 'src/a/b.ts', false],
      ['src/t?st.ts', 'src/test.ts', true],
      ['src/t?st.ts', 'src/t/st.ts', false],
      ['**/*.{stories,fixture}.tsx', 'a/B.fixture.tsx', true],
      // Outside braces, `,` and `}` are literal, like `[`, `(` and `+`.
      ['a,b}.ts', 'a,b}.ts', true],
      ['src/[id]/(group)/+page.ts', 'src/[id]/(group)/+page.ts', true],
      ['src/[id].ts', 'src/i.ts', false],
    ]
    for (const [glob, path, expected] of cases) {
      expect([glob, path, globToRegExp(glob).test(path)]).toEqual([glob, path, expected])
    }
  })
})

describe('configs', () => {
  // Rules `recommended` leaves off, because they report correct code often
  // enough to need a decision per project. Each rule's doc says why.
  const optIn = ['olas/no-network-in-components', 'olas/honor-abort-signal']

  it('recommended enables every rule except the opt-in ones; strict adds them', () => {
    const recommended = Object.keys(plugin.configs.recommended.rules ?? {})
    const strict = Object.keys(plugin.configs.strict.rules ?? {})
    const all = Object.keys(rules).map((r) => `olas/${r}`)
    expect(all).toHaveLength(8)
    expect(recommended.filter((r) => optIn.includes(r))).toEqual([])
    expect(all.filter((r) => !optIn.includes(r) && !recommended.includes(r))).toEqual([])
    expect(all.filter((r) => !strict.includes(r))).toEqual([])
  })
})
