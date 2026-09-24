import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, it } from 'vitest'
import plugin, { rules } from '../src'

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

describe('configs', () => {
  it('recommended enables every rule except the opt-in one; strict adds it', () => {
    const recommended = Object.keys(plugin.configs.recommended.rules ?? {})
    const strict = Object.keys(plugin.configs.strict.rules ?? {})
    const all = Object.keys(rules).map((r) => `olas/${r}`)
    if (recommended.includes('olas/no-network-in-components')) throw new Error('opt-in leaked')
    for (const r of all) {
      if (r !== 'olas/no-network-in-components' && !recommended.includes(r))
        throw new Error(`${r} missing`)
      if (!strict.includes(r)) throw new Error(`${r} missing from strict`)
    }
  })
})
