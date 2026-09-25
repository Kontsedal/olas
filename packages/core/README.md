# @kontsedal/olas-core

The core of Olas, independent of any UI framework. Signals, controllers, queries, mutations, forms, scopes, SSR, and the devtools event bus. No React, Vue or Svelte imports anywhere.

This package is the only place that touches `@preact/signals-core` (peer dep). Everything else is plain TypeScript.

Because it never imports a renderer, your controllers stay plain functions — construct one, drive it, and assert on its signals with no DOM, no jsdom, no Testing Library. The same controllers back React, Preact, Vue and Svelte through thin adapters: `@kontsedal/olas-react` (Preact through `preact/compat`), `@kontsedal/olas-vue` and `@kontsedal/olas-svelte`.

The package is ESM only and needs Node 20.19 or later.

## Install

```bash
pnpm add @kontsedal/olas-core @preact/signals-core
```

## What's in the box

| Concern | API |
|---|---|
| Reactive primitives | `signal`, `computed`, `effect`, `batch`, `untracked` |
| Time-based signals | `debounced`, `throttled` |
| Controllers | `defineController`, `createRoot`, `Ctx`, `ctx.child`, `ctx.attach`, `ctx.collection`, `ctx.lazyChild` |
| Query engine | `queryEngine({ defaults })`, passed as `createRoot(app, { queries })` |
| Async data — shared | `defineQuery`, `defineInfiniteQuery`, `createQuery`, `bindQuery` |
| Async data — local | `createCache` |
| Mutations | `defineMutation`, `createMutation` with `parallel` / `latest-wins` / `serial` modes |
| Forms | `createField`, `createForm`, `createFieldArray`, stdlib validators, `validator` for any Standard Schema |
| Cross-tree data | `defineScope`, `ctx.provide`, `ctx.inject`, `root.inject` |
| Events | `createEmitter`, `ctx.emitter`, `ctx.on` |
| Lifecycle | `ctx.effect`, `ctx.onDispose`, `ctx.onSuspend`, `ctx.onResume`, `root.suspend`, `root.resume` |
| Plugins | `definePlugin({ name, setup(host) })`, `OlasPlugin`, `PluginHost` |
| SSR | `root.waitForIdle()`, `root.dehydrate()`, `createRoot(def, { hydrate })`, `root.hydrate(state)`, `serializeForScript` |
| Devtools | `root.debug.subscribe(handler)` (events documented in `DebugEvent`) |
| Errors | `RootOptions.onError`, `ErrorContext`, `isAbortError`, `QueryDisabledError`, `MutationDisposedError` |
| Selection | `createSelection` |

Full reference with signatures and examples: [`../../API.md`](../../API.md).

## 30-second example

```ts file=counter.ts
import { createRoot, defineController, signal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return { count, increment: () => count.update((n) => n + 1) }
})

const root = createRoot(counter, { deps: {} })
root.api.increment()
console.log(root.api.count.value)    // 1
root.dispose()
```

`createRoot` returns a handle. What the controller returned is on `root.api`. The root's own controls sit beside it: `dispose`, `suspend`, `resume`, `dehydrate`, `hydrate`, `waitForIdle`, `bindQuery`, `inject` and `debug`. A controller can therefore name its members anything, `dispose` included.

This counter makes no query, so its root needs no query engine. A root whose controllers make a query, a mutation or a bound query takes one: `createRoot(app, { deps, queries: queryEngine() })`. Root-wide query defaults live on the engine, as `queryEngine({ defaults: { staleTime: 30_000 } })`. A root without an engine keeps the query code out of the bundle.

…and the whole test, no renderer required:

```ts
import { createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { counter } from './counter'

test('counter increments', () => {
  const { api } = createTestController(counter, { deps: {} })
  api.increment()
  expect(api.count.peek()).toBe(1)
})
```

## Sub-paths

- `@kontsedal/olas-core` — the main entry.
- `@kontsedal/olas-core/testing` — test-only helpers; the sub-path makes "you imported testing utilities into production code" loud and grep-able:
  - `createTestController` builds a root around one controller. Unlike `createRoot`, it gives the root a query engine by default, and it takes `plugins`, `scopes` and `hydrate`.
  - `fakeField` and `fakeAsyncState` stand in for a real `Field` and a real query state in a component test.
  - `mockFetchPlugin` answers fetches by query id, and `createPluginRecorder` records every plugin event a root emits, for assertions.

```ts
import {
  createPluginRecorder,
  createTestController,
  fakeAsyncState,
  fakeField,
  mockFetchPlugin,
} from '@kontsedal/olas-core/testing'
```

## Root-scoped operations and SSR

Use `bindQuery(ctx, query)` or `root.bindQuery(query)` to obtain imperative operations for one root. The handle supports the same cache actions as the definition, without subscribing or fetching. Unbound methods fail when multiple roots have touched the query. Bound prefetch works before the first subscription, and bound operations fail after root disposal.

`defineQuery`, `defineInfiniteQuery` and `defineMutation` each require an `id`. SSR keys every dehydrated entry by its query's id, so a query id must be unique and the same in the server and client bundles. `root.dehydrate()` includes infinite queries, with their page params, so the client pages on from where the server stopped. Query data is untrusted text, so inline it with `serializeForScript(root.dehydrate())`. It writes `JSON.parse("…")` over a string with every quote, angle bracket, ampersand and line separator escaped, so the payload cannot end its `<script>` tag or form markup (§22).

Coming from 0.8, `npx @kontsedal/olas-codemod 1.0` rewrites the mechanical renames, and [the migration guide](../../MIGRATING.md) covers the rest.

## Further reading

- [`../../API.md`](../../API.md) — every export, signature, example.
- [`../../README.md`](../../README.md) — guided tour.
- [`../../PLUGINS.md`](../../PLUGINS.md) — the plugin authoring guide.
- [`../../SPEC.md`](../../SPEC.md) — authoritative design.
- [`../../.wiki/modules/`](../../.wiki/modules/) — per-module pages (signals, controller, query, forms, …).
- [`../../.wiki/pitfalls/`](../../.wiki/pitfalls/) — known footguns.
