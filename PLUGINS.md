# Writing an Olas plugin

A plugin extends every root it is installed in: it observes cache writes and mutation runs, wraps fetches and mutate calls, and can expose a service to controllers. This guide covers the contract, the four shapes a plugin takes, and how to test one. The contract itself is SPEC §13; the types live in `@kontsedal/olas-core` (`OlasPlugin`, `PluginHost`, `PluginHooks`).

```ts
import { createRoot, definePlugin, queryEngine } from '@kontsedal/olas-core'
import { app, deps } from './app'

export const logger = definePlugin({
  name: 'logger',
  setup(host) {
    return {
      onWrite: (e) => console.log(e.query.id, e.source, e.origin),
    }
  },
})

createRoot(app, { deps, queries: queryEngine(), plugins: [logger] })
```

## The contract

- **A plugin is a definition.** `setup(host)` runs once for every root the plugin is installed in. Per-root state lives in `setup`'s closure, so one plugin value serves any number of roots, including a `HydrationBoundary` that rebuilds its root under StrictMode. A plugin that takes options is a function that returns the definition, like `crossTabPlugin({ channelName })`.
- **`setup` runs before the root controller's factory,** in `plugins` order. A scope the plugin `provide`s is visible to every controller. A throw from `setup` aborts `createRoot`, and the plugins already set up are disposed first, in reverse order.
- **The name is unique within a root.** It attributes the plugin's errors (`ErrorContext.pluginName`) and labels its devtools lane. It is also the `origin` stamped on every write the plugin makes through `host.queries`, and on the mutation runs it starts through `host.mutations.run`.
- **Observation hooks are synchronous.** They run after the change is visible to subscribers. A throw is isolated to the plugin and reported to the root's `onError`. No hook runs once the root starts disposing.
- **Middleware composes in `plugins` order, the first outermost.** `wrapFetch` and `wrapMutate` run around every attempt, retries included. A throw fails the attempt like a fetcher throw.
- **Disposal runs in reverse `plugins` order,** after the controller tree and before the query client. The `dispose` hook runs first, then the `host.onDispose` callbacks.

## What `setup` receives

| Member | For |
|---|---|
| `deps` | The root's `deps`. |
| `provide(scope, value)` | Exposing a service. Only during `setup`. A `RootOptions.scopes` binding for the same scope wins. |
| `reportError(err)` | Routing an error to `onError` as `{ kind: 'plugin', pluginName }`. |
| `onDispose(fn)` | Teardown, after the `dispose` hook. |
| `track(promise)` | Making `root.waitForIdle()` wait for the plugin's own work: a restore, a replay. |
| `network` | `isOnline()`, `onReconnect(fn)` and `onFocus(fn)`, shared with the query engine. |
| `queries` | Cache access by query `id` and entry `key`: `get`, `keys`, `peek`, `write`, `replace`, `invalidate`, `hydrate`, `dehydrate`, `hashKey`. `get(id)` returns the `QueryRef` of a query this root has used: its `id`, `kind` and `meta`. `write` and `replace` skip a key this root holds no entry for. `null` without a query engine. |
| `mutations` | `has(id)`, `get(id)` and `run(id, variables)` for mutations registered with `defineMutation`. `get(id)` returns the definition's `id` and `meta`. `run` goes through the core runner: retry, `deps`, devtools, `waitForIdle`. `null` without a query engine. |
| `debug(payload)` | A development-only payload on the plugin's devtools lane. |

## The hooks

| Hook | Fires when |
|---|---|
| `onWrite(e)` | A cache entry's data changed. `e.source` is `'fetch'`, `'hydrate'`, `'optimistic'`, `'rollback'`, `'write'` or `'replace'`. `e.origin` names the plugin or tagged handle that wrote it, and is `undefined` for the app and the engine's own fetches. An infinite query's write carries `e.pageParams`. |
| `onInvalidate(e)` | An entry was invalidated. |
| `onRemove(e)` | The cache garbage-collected an entry. |
| `onActivate(e)` / `onDeactivate(e)` | An entry gained its first subscriber, or lost its last. |
| `onMutation(e)` | A mutation run moved a step: `'start'`, then exactly one of `'success'`, `'error'` or `'cancel'`. Every run, with or without an `id`. |
| `wrapFetch(ctx, next)` | Around every fetch attempt. |
| `wrapMutate(ctx, next)` | Around every `mutate` attempt. |
| `dispose()` | Once, when the root disposes. |

## Four shapes

**An observer** reads events and keeps its own record: a logger, an analytics bridge, the query-cache persister in `@kontsedal/olas-persist` (`persistQueryCachePlugin`).

**Middleware** wraps the fetch or mutate chain. It can time the chain, rewrite its result, retry it, or answer without calling `next()`. The tracing example in `examples/kanban/src/tracing.ts` times each attempt. `mockFetchPlugin` from `/testing` answers fetches outright.

```ts
import { definePlugin } from '@kontsedal/olas-core'

export const slowFetchLog = definePlugin({
  name: 'slow-fetch-log',
  setup() {
    return {
      wrapFetch: async (ctx, next) => {
        const started = performance.now()
        try {
          return await next()
        } finally {
          const ms = Math.round(performance.now() - started)
          if (ms > 1000) console.warn(`${ctx.query.id} attempt ${ctx.attempt} took ${ms} ms`)
        }
      },
    }
  },
})
```

**A service** exposes an object through a scope, so controllers `ctx.inject(Scope)` it and the app `root.inject(Scope)`s it. `@kontsedal/olas-entities` provides its store as `Entities`; `@kontsedal/olas-mutation-queue` provides `MutationQueue`.

```ts
import { definePlugin, defineScope, type ReadSignal, signal } from '@kontsedal/olas-core'

export type TraceService = { readonly spans: ReadSignal<readonly string[]> }
export const Traces = defineScope<TraceService>({ name: 'Traces' })

export const tracing = definePlugin({
  name: 'tracing',
  setup(host) {
    const spans = signal<readonly string[]>([])
    host.provide(Traces, { spans })
  },
})
```

**A relay** carries cache state across a boundary and writes it into the cache on the other side. `@kontsedal/olas-cross-tab` relays between tabs and writes through `host.queries`. The streaming hydrator relays from server to client: its plugin records the server root's writes, and the client applies them with `root.hydrate`. The writes a relay makes through `host.queries` reach its own `onWrite` with its name as `origin`, so it must skip them there, or it echoes them back.

## Checklist

1. **Keep per-root state inside `setup`.** A `let` at module level is shared by every root, and the tests of two roots will interfere.
2. **Handle `host.queries === null`.** A root without a query engine has no cache. A plugin that cannot work without one throws from `setup` with the fix, as cross-tab, entities and the mutation queue do. A plugin that can do without warns in development and returns no hooks, as the query-cache persister does.
3. **Skip your own writes.** Check `event.origin === YOUR_NAME` in `onWrite` and `onInvalidate`.
4. **Persist or relay only canonical writes.** `'optimistic'` and `'rollback'` are guesses the server has not confirmed.
5. **Carry `pageParams` with an infinite query's pages** (`e.pageParams`, and `{ pageParams }` on `write` and `replace`), or the receiving entry's cursors drift.
6. **`track` asynchronous startup work,** so `waitForIdle` and SSR wait for it.
7. **Release what you subscribe to.** The host releases the `network.onReconnect` and `onFocus` listeners when the plugin disposes, and the unsubscribe each returns stops one sooner. Close anything the plugin opens itself, such as a `BroadcastChannel`, in `dispose` or `onDispose`.
8. **Type per-query settings through `QueryMeta` and `MutationMeta` augmentation,** not a side registry:

   ```ts
   declare module '@kontsedal/olas-core' {
     interface QueryMeta {
       audit?: boolean
     }
   }
   ```

9. **Export the name as a constant** (`CROSS_TAB_PLUGIN_NAME`), so other plugins can filter by origin.
10. **Treat stored and received data as untrusted.** Validate its shape before you `hydrate` or `write` it.

## Testing a plugin

`createTestController(def, { plugins })` installs plugins on a test root. `@kontsedal/olas-core/testing` has two helpers:

- **`createPluginRecorder()`** records every observation event a root emits, for assertions on `source`, `origin` and mutation phases.
- **`mockFetchPlugin(handlers)`** answers fetches by query id without their fetchers: canned data, a function of the attempt, or an error, with optional latency. An unmocked query fails its fetch unless `{ passthrough: true }`.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const appController: ControllerDef<void, unknown>
-->
```ts
import {
  createPluginRecorder,
  createTestController,
  mockFetchPlugin,
} from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { myPlugin } from './my-plugin'

test('my-plugin writes once', async () => {
  const rec = createPluginRecorder()
  const { waitForIdle } = createTestController(appController, {
    deps: {},
    plugins: [mockFetchPlugin({ 'user/detail': { data: { id: 1 } } }), myPlugin, rec.plugin],
  })
  await waitForIdle()
  expect(rec.writes.filter((w) => w.origin === 'my-plugin')).toHaveLength(1)
})
```

The first-party plugins are working references: `packages/cross-tab`, `packages/entities`, `packages/mutation-queue`, `packages/persist/src/query-cache.ts`, `packages/router/src/adapter.tsx` and `packages/react/src/streaming.ts`.
