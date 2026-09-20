---
'@kontsedal/olas-core': major
---

**Breaking.** The lifetime-owned primitives take `ctx` as their first argument instead of hanging off it, and the query engine is now explicit on `createRoot`. A controllers-only bundle drops from 20.1 KB gzipped to 4.8 KB.

```ts
// before
const root = createRoot(app, { deps })
const app = defineController((ctx) => {
  const email = ctx.field('')
  const user = ctx.use(userQuery, () => [id.value])
  const save = ctx.mutation({ mutate: (v, signal) => api.save(v, signal) })
})

// after
import { createField, createMutation, createQuery, queryEngine } from '@kontsedal/olas-core'

const root = createRoot(app, { deps, queries: queryEngine() })
const app = defineController((ctx) => {
  const email = createField(ctx, '')
  const user = createQuery(ctx, userQuery, () => [id.value])
  const save = createMutation(ctx, { mutate: (v, signal) => api.save(v, signal) })
})
```

| Was | Now |
|---|---|
| `ctx.field(...)` | `createField(ctx, ...)` |
| `ctx.form(...)` | `createForm(ctx, ...)` |
| `ctx.fieldArray(...)` | `createFieldArray(ctx, ...)` |
| `ctx.cache(...)` | `createCache(ctx, ...)` |
| `ctx.use(...)` | `createQuery(ctx, ...)` |
| `ctx.mutation(...)` | `createMutation(ctx, ...)` |
| `ctx.bindQuery(...)` | `bindQuery(ctx, ...)` |

`ctx` is unchanged for everything that binds to the controller's tree and lifetime: `emitter`, `child`, `attach`, `collection`, `session`, `lazyChild`, `effect`, `on`, `provide`, `inject`, `debug`, the lifecycle hooks, and `signal`/`computed`.

**`createRoot` needs `queries: queryEngine()`** for any root whose controllers call `createQuery`, `createMutation` or `bindQuery`. Without it those throw a message naming the fix. `createCache` needs no engine — a controller-local cache is not a client entry. `createTestController` supplies an engine by default; pass `queries: null` to assert the no-engine path.

**Why.** `Ctx` was one object with every method wired eagerly, built in a module that `createRoot` always reaches, so every consumer shipped the forms subsystem and the query engine whether or not a single field or query existed. As named exports they are droppable. `createRoot` likewise constructed a `QueryClient` unconditionally; that construction now lives in `query/engine.ts`, the only module importing the client by value.

The engine is adopted **eagerly**, inside `createRoot`, before the factory runs — plugin `init` fires exactly when it always did. That is load-bearing: `mutationQueuePlugin` replays mutations persisted by a previous session at `init`, and deferring it would strand a user's offline writes.

Measured with `esbuild --bundle --minify --define:__DEV__=false`, gzipped, `@preact/signals-core` external: signals only 0.3 KB; `+ createRoot`/`defineController` 4.8 KB (was 20.1); `+ forms` 9.2 KB; `+ queries` 14.4 KB; everything 22.6 KB (was 21.8). Importing everything costs 0.8 KB more than before — that is the indirection, paid by the people who use the features.

Full reasoning, including the naming decision and what SPEC's earlier "we rejected splitting ctx" note did and did not cover, is in `.wiki/decisions/ctx-primitives-are-free-functions.md`. Migration steps are in `MIGRATING.md`.
