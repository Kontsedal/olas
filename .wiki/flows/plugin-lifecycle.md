---
name: plugin-lifecycle
description: One plugin in one root, end to end — setup in order at createRoot, the write path to onWrite with origin stamping, wrapFetch and wrapMutate composition, activation, onMutation, and the reverse dispose.
type: flow
covers:
  - packages/core/src/plugin/host.ts
  - packages/core/src/plugin/types.ts:27-70
  - packages/core/src/plugin/types.ts:248-299
  - packages/core/src/controller/root.ts:19-127
  - packages/core/src/controller/root.ts:191-201
  - packages/core/src/query/client.ts:281-335
  - packages/core/src/query/client.ts:735-987
  - packages/core/src/query/client.ts:1043-1095
  - packages/core/src/query/client.ts:1252-1332
  - packages/core/src/query/client.ts:1360-1410
  - packages/core/src/query/client.ts:1509-1623
  - packages/core/src/query/client.ts:1876-1912
  - packages/core/src/query/actions.ts:24-69
  - packages/core/src/query/bind.ts:131-155
  - packages/core/src/query/mutation.ts:298-363
  - packages/core/src/query/mutation.ts:466-663
edges:
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/coverage-core-plugins.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/coverage-core-plugin-network.test.ts }
  - { type: documented-in, target: ../../PLUGINS.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: uses, target: ../entities/mutation.md }
  - { type: related, target: ../modules/cross-tab.md }
  - { type: related, target: ../modules/entities.md }
  - { type: related, target: ../modules/mutation-queue.md }
last_verified: 2026-09-25
confidence: high
---

# Flow: a plugin's life in one root

The steps one plugin value goes through in one root, from `createRoot` to `root.dispose()`. The contract and the reasons for it are in `../decisions/plugin-host-v2.md`, and the authoring guide is `../../PLUGINS.md`. Spec §13.

```
createRoot(app, { queries: queryEngine(), plugins: [a, b] })
  1. QueryClient created; RootOptions.hydrate buffered        root.ts:35-42
  2. PluginSet.install: a.setup(host), then b.setup(host)     host.ts:77-125
  3. plugin scopes seeded, then RootOptions.scopes            root.ts:65-83
  4. the root factory runs                                    root.ts:88-95

at runtime
  cache write    -> QueryClient.emitWrite -> PluginSet.emit -> a.onWrite, b.onWrite
  fetch attempt  -> runFetch      -> a.wrapFetch( b.wrapFetch( fetcher ) )
  mutate attempt -> runWithRetry  -> a.wrapMutate( b.wrapMutate( mutate ) )

root.dispose()
  close delivery -> close client -> controllers -> b, then a -> client
```

## 1. Setup runs in order, before the factory

- `createRootWithProps` builds a `PluginSet` only when `plugins` is non-empty (`packages/core/src/controller/root.ts:26-29`). Without one, each emit site in `QueryClient` returns at its `plugins === null` check.
- The `QueryClient` is created first (`root.ts:35-42`), so a plugin's `setup` can reach the cache. The client buffers `RootOptions.hydrate` there and reports nothing yet (`packages/core/src/query/client.ts:731`, `client.ts:1084-1095`).
- `PluginSet.install` calls each `setup(host)` in `plugins` order (`packages/core/src/plugin/host.ts:77-125`). It rejects an empty or duplicate `name` before that plugin's setup, and disposes the plugins already set up (`host.ts:84-95`).
- `makeHost` gives each plugin its own host (`host.ts:127-171`). `host.queries` is the client's `queryHost(name)` and `host.mutations` its `mutationHost(name)`. Both are `null` without an engine (`host.ts:164-165`).
- `host.provide` works only while that plugin's `setup` runs, and a later call throws (`host.ts:97-106`). `createRoot` seeds the collected bindings on the root instance, then seeds `RootOptions.scopes` over them (`root.ts:76-83`), so a test's fake wins.
- `install` files each returned hook object. A plugin with `wrapFetch` or `wrapMutate` joins that middleware list, and one with `onMutation` or `wrapMutate` sets `observesMutations` (`host.ts:118-122`).
- The root factory runs last. A factory throw disposes the plugins, then the client (`root.ts:88-95`).

Pinned by `plugin-host.test.ts`: "runs once per root, in order, before the root factory", "names must be present and unique", "works without a query engine: queries and mutations are null", and the three `scopes` tests.

## 2. A setup throw unwinds in reverse

`install` catches a throwing `setup` (`host.ts:107-117`). It files the half-set-up plugin with no hooks, so the `onDispose` functions and network subscriptions that plugin registered before the throw still run. It then calls `dispose()`, which walks the installed plugins last to first. `createRoot` disposes the client and rethrows (`root.ts:72-75`), and the factory never runs.

For each plugin, `dispose()` calls the hook `dispose` first and then the registered disposers, newest first (`host.ts:227-251`). "a throwing setup aborts createRoot and disposes earlier plugins in reverse" pins the order as `dispose:b, disposer:b, dispose:a, disposer:a`.

## 3. The write path to `onWrite`

Every cache write reaches the plugins through one private emitter, `QueryClient.emitWrite` (`client.ts:763-783`). It asks `plugins.listens('onWrite')` first, so a root whose plugins have no `onWrite` builds no event. `updatedAt` is the entry's `lastUpdatedAt`, or `Date.now()` when that is absent. An infinite write goes through `emitInfiniteWrite` first (`client.ts:786-802`), which adds the entry's `pageParams`.

| `source` | Emitted by | `origin` |
|---|---|---|
| `'fetch'` | the `onFetched` closure `bindEntry` hands the entry (`client.ts:1294-1302`), on each successful fetch | `undefined` |
| `'hydrate'` | `bindEntry` adopting a buffered payload (`client.ts:1322-1332`), or `applyDehydratedEntry` on a bound entry (`client.ts:1043-1071`) | whoever hydrated: `undefined` for `RootOptions.hydrate` and `root.hydrate`, the plugin's name for `host.queries.hydrate` |
| `'optimistic'` | `setData` (`client.ts:1581-1600`) | the handle's origin |
| `'rollback'` | that snapshot's `rollback()`, only when the data changed (`client.ts:1604-1620`) | the handle's origin |
| `'write'`, `'replace'` | `writeData` and `replaceData` (`client.ts:1509-1579`), or `host.queries.write` and `replace` through `writeByKey` (`client.ts:954-987`) | the handle's origin, or the plugin's name |

`createQueryActions(query, getClient, origin)` passes the handle's origin to every write and invalidation (`packages/core/src/query/actions.ts:24-69`). The module-level query methods and `bindQuery(ctx, q)` pass none. `bindQuery(ctx, q, { origin })` and `root.bindQuery(q, { origin })` pass theirs (`client.ts:1252-1271`). `refOf` caches one `QueryRef` per query for every event (`client.ts:735-746`).

A `host.queries` write differs from an app write in one respect. `writeByKey` returns without writing when this root holds no entry for the key (`client.ts:962-963`), where the app's `write` binds one.

`PluginSet.emit` calls each plugin's hook in install order, each inside its own `try` (`host.ts:178-189`). A throw reaches the root's `onError` as `{ kind: 'plugin', pluginName }`, and the next plugin still runs.

`onInvalidate` takes the same route. `invalidate`, `invalidateAll` and `host.queries.invalidate` first run `invalidateEntry`, which refetches a subscribed entry or marks an unsubscribed one stale (`client.ts:1383-1410`). They then call `emitInvalidated` with the caller's origin (`client.ts:804-812`).

Pinned by `plugin-host.test.ts`:
- the `onWrite` tests: the five local sources in order, and one `'hydrate'` write each for a bound entry and a buffered payload;
- the origin of host and tagged-handle writes, and host writes to an absent entry;
- "carries origin, and a host invalidate refetches only a subscribed entry";
- "a throwing hook reaches onError with the plugin name; later plugins still run".

## 4. Activation, deactivation and removal

`ClientEntry.acquire` reports `onActivate` on the 0→1 subscriber transition, and `release` reports `onDeactivate` on 1→0 (`client.ts:298-335`). `InfiniteClientEntry` does the same (`client.ts:530-591`). A second subscriber joining or leaving reports nothing.

`dropEntry` and `dropInfiniteEntry` report `onRemove` with `reason: 'gc'` when gc drops an entry (`client.ts:1360-1374`, `client.ts:1688-1702`). A root dispose reports no removals: the client disposes its entries directly, and delivery is closed by then.

Pinned by "onActivate / onDeactivate fire on the 0→1 and 1→0 transitions only" and "onRemove fires when an entry is garbage collected".

## 5. Middleware: `wrapFetch` and `wrapMutate`

`compose` builds the chain from the last wrapper to the first, so the first plugin in `plugins` is outermost (`host.ts:254-274`). Each link calls its wrapper with the context and the inner link as `next`. A wrapper may call `next()` again, answer without it, or throw. `compose` turns a synchronous throw into a rejected promise, which fails the attempt like a fetcher throw.

- **Fetch.** Both entry kinds call their fetcher through `client.runFetch` (`client.ts:281-285`, `client.ts:507-512`). `runFetch` calls the fetcher directly when no plugin wraps fetches (`client.ts:829-833`). The retry loop sits inside the entry, so each attempt runs through the chain with its own `attempt` number. `FetchContext` carries the `QueryRef`, the key, the call args, the signal, the attempt and, for an infinite query, the `pageParam` (`packages/core/src/plugin/types.ts:248-258`).
- **Mutate.** `MutationImpl.runWithRetry` wraps each `mutate` call when the lifecycle carries a `wrap` (`packages/core/src/query/mutation.ts:634-663`). `MutateContext` carries the `MutationRef`, the `runId`, the variables, the signal, the attempt and the origin.

Pinned by "wrapFetch composes in plugin order, first outermost, and can answer without fetching", "wrapFetch sees each retry attempt and the infinite page", "wrapMutate wraps every attempt", and `coverage-core-plugins.test.ts` "a wrapFetch that throws synchronously fails the fetch with that error".

## 6. `onMutation`

`QueryClient.mutationLifecycle(origin?)` returns `undefined` unless a plugin set `observesMutations` (`client.ts:839-849`). `createMutation` reads it when a controller builds the mutation (`packages/core/src/query/bind.ts:142-152`), so a root whose plugins ignore mutations builds no mutation events.

`MutationImpl.report` sends each step of a run (`mutation.ts:345-363`):
- `'start'` after `onMutate` returns and before the first `mutate` call (`mutation.ts:524`). A run aborted during `onMutate` reports nothing.
- Then exactly one of `'success'`, `'error'` or `'cancel'` (`mutation.ts:526-597`). A run whose work finished before a late abort reports `'success'`, and the `settledOutcome` flag keeps it to that one outcome (`mutation.ts:528-550`).

Every event carries the `MutationRef`, the `runId` and the variables. The ref's `id` is `undefined` for an inline spec without one, and a plugin filters on its `meta`.

`host.mutations.run(id, vars)` runs a `defineMutation` through the same runner (`client.ts:903-933`). The client keeps one runner per plugin and id, so `serial` and `latest-wins` hold across that plugin's runs. The runner gets `mutationLifecycle(origin)`, so its events and its `MutateContext` carry the plugin's name. It counts toward `mutationsInflight$`, and so toward `waitForIdle`.

Pinned by "every run reports start then one outcome, with variables and meta", "reset() reports cancel", "an abort landing after the work finished still reports success" and "run goes through the runner: retry, deps, waitForIdle, origin".

## 7. `track` and `waitForIdle`

`host.track(work)` adds the settled form of `work` to the set's pending work (`host.ts:155-162`). `root.waitForIdle()` alternates between the client's own wait and `plugins.pendingWork()` until a round finds no plugin work, for up to 100 rounds (`root.ts:191-201`). The loop exists because plugin work can start fetches and a settling fetch can start plugin work. Pinned by "track() makes waitForIdle wait for the work".

## 8. Dispose

`root.dispose()` runs five steps in this order (`root.ts:111-127`):

1. `plugins.close()`. From here `emit` and `listens` return early (`host.ts:179`, `host.ts:193`), and `host.debug` is silent (`host.ts:167`).
2. `queryClient.close()`. An entry released from here arms no gc timer (`client.ts:325`, `client.ts:1876-1882`).
3. `instance.dispose()`. The controllers tear down in reverse registration order. Their subscriptions release entries and their mutations cancel runs, and none of it reaches a plugin.
4. `plugins.dispose()`, last plugin first. Each gets its hook `dispose`, then its `host.onDispose` functions and network subscriptions, newest first (`host.ts:227-251`). A throw in either reaches `onError` with the plugin's name, and the teardown continues.
5. `queryClient.dispose()`. The client disposes its entries, then the runners `host.mutations.run` created (`client.ts:1884-1912`). A replay still in flight is cancelled here, after its plugin has disposed.

Pinned by "no hook runs once the root starts disposing, and plugins dispose in reverse", and by `coverage-core-plugins.test.ts` ("host.debug is silent once the root has disposed", "a throwing dispose hook or disposer reaches onError; the rest still tear down"). `coverage-core-plugin-network.test.ts` pins that the root dispose unsubscribes `host.network.onFocus`.

## Read from code, not pinned by a test

- The `listens` and `observesMutations` short-circuits build no event when no plugin wants one. No test measures that no event is built.
- A root dispose reports no `onRemove`.
- `host.mutations.run` keeps one runner per plugin and id.
