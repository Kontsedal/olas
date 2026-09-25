---
'@kontsedal/olas-core': major
---

**Breaking.** The lifetime-owned primitives are free functions that take `ctx` first, and a root that uses queries takes an explicit query engine. A controllers-only bundle built from the published `dist` is 5.9 KB gzipped. In 0.8 it was 19.9 KB.

```ts
// 0.8
const app = defineController((ctx) => {
  const email = ctx.field('')
  const user = ctx.use(userQuery, () => [id.value])
})
const root = createRoot(app, { deps })

// 1.0
import { createField, createQuery, queryEngine } from '@kontsedal/olas-core'

const app = defineController((ctx) => {
  const email = createField(ctx, '')
  const user = createQuery(ctx, userQuery, () => [id.value])
})
const root = createRoot(app, { deps, queries: queryEngine() })
```

| 0.8 | 1.0 |
|---|---|
| `ctx.field(...)` | `createField(ctx, ...)` |
| `ctx.form(...)` | `createForm(ctx, ...)` |
| `ctx.fieldArray(...)` | `createFieldArray(ctx, ...)` |
| `ctx.cache(...)` | `createCache(ctx, ...)` |
| `ctx.use(...)` | `createQuery(ctx, ...)` |
| `ctx.mutation(...)` | `createMutation(ctx, ...)` |
| `ctx.bindQuery(...)` | `bindQuery(ctx, ...)` |

`ctx` keeps the members that bind to the controller's tree and lifetime: `emitter`, `child`, `attach`, `collection`, `lazyChild`, `effect`, `on`, `provide`, `inject`, `debug` and the lifecycle hooks.

**A root whose controllers call `createQuery`, `createMutation` or `bindQuery` needs `queries: queryEngine()`.** Without an engine, those calls throw an error that names the fix. `createCache` needs no engine, because a controller-local cache is not a client entry. Forms, effects, children and emitters need none either. `createTestController` supplies an engine by default. Pass `queries: null` to test the no-engine path.

**Why.** In 0.8, `Ctx` was one object with every method wired eagerly, in a module that `createRoot` imports. Every consumer shipped the forms subsystem and the query engine, whether or not the app had a field or a query. As named exports, a bundler drops the ones an app does not import. The query client is built in `query/engine.ts`, and nothing else imports it by value.

The numbers come from `esbuild --bundle --minify` over `dist`, gzipped, with `@preact/signals-core` external. `pnpm size` checks per-entry budgets in CI. `.wiki/decisions/ctx-primitives-are-free-functions.md` has the reasoning, including the naming decision. `MIGRATING.md` and `npx @kontsedal/olas-codemod 1.0` cover the migration.
