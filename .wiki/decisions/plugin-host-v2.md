---
name: plugin-host-v2
description: Why plugins are per-root definitions with a setup(host), how events, origins, middleware and services work, and what the old QueryClientPlugin got wrong.
type: decision
covers:
  - packages/core/src/plugin/types.ts
  - packages/core/src/plugin/host.ts
  - packages/core/src/query/client.ts
  - packages/core/src/controller/root.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: related, target: required-id-and-meta.md }
  - { type: related, target: root-handle-separate.md }
  - { type: related, target: per-root-query-client.md }
last_verified: 2026-09-24
confidence: medium
---

# Plugin host v2

## The contract

```ts
type OlasPlugin = { name: string; setup(host: PluginHost): PluginHooks | void }
```

A plugin is a **definition**. `createRoot` calls `setup` once per root, in `plugins` order, before the root controller's factory. Per-root state lives in `setup`'s closure. The host gives the plugin five things:
- `deps`
- `provide(scope, value)`
- `reportError`, `onDispose` and `track`
- `network` (online/focus)
- `queries` and `mutations`, both `null` without an engine

`setup` returns observation hooks (`onWrite`, `onInvalidate`, `onRemove`, `onActivate`, `onDeactivate`, `onMutation`), middleware (`wrapFetch`, `wrapMutate`) and `dispose`.

Runtime: `PluginSet` in `plugin/host.ts`. The query-engine half of the host (`queryHost(origin)`, `mutationHost(origin)`, `runFetch`, `mutationLifecycle`) lives on `QueryClient`. It is passed to `PluginSet.install` as a `PluginEngine`, so a root without an engine never bundles the client.

## What the old `QueryClientPlugin` got wrong

The old plugin was a stateful object with `init(api)` and six hooks, installed by the `QueryClient`. The [0.9 review](../log.md) found six structural problems.

1. **Instances, not definitions.** A plugin value held one root's state, so it needed a per-plugin reuse guard, and only some plugins had one. Because the engine owned the plugins, the engine itself became adoptable only once. That is what made `HydrationBoundary` throw under StrictMode.
2. **Core named its plugins.** `crossTab` and `persist` were core spec fields. That is fixed separately by `meta`; see [required-id-and-meta](required-id-and-meta.md).
3. **No service lookup.** `EntitiesPlugin` doubled as the entity store, so apps threaded the plugin object through `deps` and module variables.
4. **Ambiguous events.** `source: 'set'` covered optimistic writes, canonical writes, rollbacks and plugin backprop alike. `isRemote` was one client-wide flag set around remote applies. Nothing carried `updatedAt`. Mutation events fired only for `persist: true`.
5. **Lifecycle holes.** Hooks kept firing after `dispose`, a plugin whose `init` threw stayed installed, and disposal ran in install order.
6. **Two parallel observation channels.** The debug bus keyed events by `keyArgs` with no query id and used a `'mutate'` source; plugin hooks used the query id and `'set'`.

## The decisions

**Setup per root, run by `createRoot`.** This fixes (1). It also lets a plugin work without a query engine: the router bridge only provides scopes. And a plugin can provide a scope before any controller runs.

**Services through scopes.** `host.provide(Entities, store)`, then `ctx.inject(Entities)` / `root.inject(Entities)`. This reuses the scope machinery rather than inventing a plugin registry. A test stands in a fake with `RootOptions.scopes`, which seeds after the plugins and so wins.

**One write vocabulary, plus an `origin`.** This fixes (4). `WriteSource` is:
- `'fetch'`
- `'hydrate'`
- `'optimistic'`
- `'rollback'`
- `'write'`
- `'replace'`

Every write carries an `origin`: the name of the plugin whose host made it, the `origin` given to `bindQuery(ctx, q, { origin })`, or `undefined` for the app. That makes echo prevention generic. Cross-tab mirrors only origin-`undefined` writes by default, so it never re-broadcasts what it applied from a peer, a realtime push every tab receives, or an entity backprop that a peer's own entities plugin re-derives from the mirrored write. The last is the N-payload amplification the review found. An `entities.update(...)` patch has no write for a peer to re-derive it from, so it stays in its tab unless cross-tab's `origins` names `ENTITIES_PLUGIN_NAME`.

Devtools `cache:set-data` uses the same `source` enum and now carries `queryId`, which fixes (6) for writes.

**One event per write.** Hydrating a bound entry used to report twice: `Entry.applyHydration` called the fetch-success callback, and the client then emitted its own. Now `applyHydration` reports nothing; the client reports one `'hydrate'` write.

**Every mutation reports.** `onMutation` fires for every run, with or without an `id`: `start` after `onMutate`, then exactly one of `success`, `error` or `cancel`, with variables on every phase. A plugin filters on `mutation.meta`.

`host.mutations.run(id, vars)` runs a `defineMutation` through the real runner. Retry applies, `deps` flow, the run counts toward `waitForIdle`, and its events carry the plugin's name as `origin`. The mutation queue replays this way and ignores its own replays in `onMutation`.

**Middleware.** `wrapFetch` and `wrapMutate` wrap every attempt, first plugin outermost, and `next()` may be called again to retry. They enable auth refresh, tracing, logging and mock responses. `FetchContext` carries the attempt number and, for an infinite query, the page param.

**Strict lifecycle.** This fixes (5):
- A `setup` throw aborts `createRoot`, after disposing the plugins already set up in reverse.
- `root.dispose()` closes delivery first, so nothing teardown causes reaches a plugin.
- Then controllers dispose, then plugins in reverse (hook `dispose`, then `onDispose` fns), then the client.
- A hook throw is isolated per plugin and reported with `pluginName`.

**Per-root id index.** The global query registry is gone. `QueryClient.byId` holds the queries a root has bound. A plugin can only address entries this root holds anyway, and a duplicate id is now a collision within one app rather than across the process. The mutation registry stays global, because a replay has to find a definition before any controller exists.

## What stayed out

Observation hooks are synchronous. An async hook would need ordering and back-pressure rules that no current plugin needs. A plugin that must await before a write proceeds uses `wrapMutate`; the mutation queue's `[planned]` persist-before-mutate item is exactly that. Controller-lifecycle hooks (`onController`) are not part of the contract yet; the devtools bus covers them in dev.
