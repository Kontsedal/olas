---
"@kontsedal/olas-core": major
"@kontsedal/olas-cross-tab": major
"@kontsedal/olas-entities": major
"@kontsedal/olas-mutation-queue": major
"@kontsedal/olas-react": major
"@kontsedal/olas-devtools": patch
---

**Plugin host v2.** A plugin is a definition with a per-root `setup`, and it gets a host, typed events, middleware and a way to expose services.

```ts
const logger = definePlugin({
  name: 'logger',
  setup(host) {
    return {
      onWrite: (e) => console.log(e.query.id, e.source, e.origin),
      wrapFetch: async (ctx, next) => {
        const t = performance.now()
        try {
          return await next()
        } finally {
          console.log(ctx.query.id, 'took', performance.now() - t)
        }
      },
    }
  },
})

createRoot(app, { deps, queries: queryEngine(), plugins: [logger] })
```

**Core (`@kontsedal/olas-core`)**

- **Definitions, not instances.** `setup(host)` runs once per root, in `plugins` order, before the root controller's factory. One plugin value can serve any number of roots. `QueryClientPlugin`, `QueryClientPluginApi` and their events are removed.
- **The host** offers several things:
  - `deps`;
  - `provide(scope, value)`, a service a controller reads with `ctx.inject(scope)` and outside code reads with `root.inject(scope)`;
  - `reportError`, `onDispose`, and `track(promise)`, which makes `root.waitForIdle()` wait;
  - `network`, for online state and focus;
  - `queries` (`get`, `keys`, `peek`, `write`, `replace`, `invalidate`, `hydrate`, `dehydrate`, `hashKey`), addressed by query `id` and entry key;
  - `mutations` (`has`, `get`, and `run(id, vars)`, which runs a `defineMutation` through the engine's runner with its retry and the root's `deps`).
- **Hooks:**
  - `onWrite` takes `source`: `'fetch'`, `'hydrate'`, `'optimistic'`, `'rollback'`, `'write'` or `'replace'`. It also carries `origin` and `updatedAt`.
  - The other observation hooks are `onInvalidate`, `onRemove`, `onActivate`/`onDeactivate` (an entry's first and last subscriber), and `onMutation` (every run of every mutation: `start`, then `success`, `error` or `cancel`).
  - Middleware: `wrapFetch` and `wrapMutate` wrap every attempt, with the first plugin outermost.
- **Origins.** A write made through a plugin's host carries the plugin's name as `origin`. `bindQuery(ctx, query, { origin })` tags a handle's writes the same way. The client-wide `isRemote` flag is gone.
- **Lifecycle:**
  - A `setup` throw aborts `createRoot`, after disposing the plugins already set up, in reverse.
  - No hook runs once the root starts disposing.
  - Plugins dispose in reverse order.
  - A hook throw reaches `onError` as `{ kind: 'plugin', pluginName }`, and the next plugin still runs.
  - Plugins work without a query engine; `host.queries` is then `null`.
- **Fixed:**
  - Hydrating a bound entry reported two writes. It now reports one `'hydrate'` write.
  - A peer's invalidation refetched entries nobody subscribed to.
  - Hooks fired after `dispose()`.
  - The query registry was process-global. It is per root now, and a duplicate `id` warns when one root binds both queries.
- **Other changes:**
  - `stableHash`, `lookupRegisteredQuery` and `lookupRegisteredMutation` leave the public surface.
  - Devtools `cache:*` events carry `queryId`, and `cache:set-data` uses the `WriteSource` vocabulary.
  - New `plugin:event` debug events come from `host.debug`.

**`@kontsedal/olas-cross-tab`** mirrors only the app's own writes (origin `undefined`) by default. Other origins opt in through `origins`. New options: `optimistic: false` mirrors only canonical writes. The reuse guard is gone.

**`@kontsedal/olas-entities`:** `entitiesPlugin({ entities: [Post, User] })` returns a plugin. The store is a per-root service: `ctx.inject(Entities)` / `root.inject(Entities)`. `entities.invalidate` is renamed `remove`, because it never refetched. Backprop writes carry the plugin's origin, so cross-tab no longer rebroadcasts N payloads per patch.

**`@kontsedal/olas-mutation-queue`:**
- `mutationQueuePlugin({ storage, keyPrefix })`; `adapter` is renamed `storage`.
- Runs persist when `meta: { persist: true }`.
- Replays go through the engine's runner: the definition's retry applies, `mutate` gets `deps`, and `waitForIdle()` sees them.
- `replayNow()` is `ctx.inject(MutationQueue).replayNow()`.
- `onReplaySettle(entry, result, queries)` receives the root's `QueryHost`.
- The startup replay is tracked, so `root.waitForIdle()` waits for it.

**`@kontsedal/olas-react`:** `createStreamingHydrator().plugin` is a v2 plugin. It captures committed writes only (fetch, write, replace) and uses each write's real `updatedAt`.
