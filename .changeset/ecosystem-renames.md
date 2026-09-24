---
"@kontsedal/olas-core": minor
"@kontsedal/olas-router": major
"@kontsedal/olas-persist": major
"@kontsedal/olas-realtime": major
"@kontsedal/olas-zod": major
"@kontsedal/olas-mutation-queue": minor
"@kontsedal/olas-react": patch
---

**The satellite packages follow the `create*` rule, and the router installs as a plugin.**

A function that takes `ctx` and builds something is named `create*`. The `use*` names read as React hooks to people and to `eslint-plugin-react-hooks`, which reports them inside a controller factory.

| Package | 0.8 | 1.0 |
|---|---|---|
| persist | `usePersisted(ctx, key, source, opts)` | `createPersisted(ctx, key, source, opts)` |
| persist | `localStorageAdapter` (an object) | `localStorageAdapter()` (a factory, like `indexedDbAdapter()`) |
| persist | `clearPersisted(storage, prefix, onError)` | `clearPersisted(storage, { prefix, onError })` |
| realtime | `useRealtimePatcher` | `createRealtimePatcher` |
| realtime | `useLiveStream` | `createLiveStream` |
| realtime | `useRealtimeConnection` | `createConnectionState` |
| zod | `formFromZod(ctx, schema, { initials })` | `createZodForm(ctx, schema, { initial })` |
| router | `createRoot(def, { scopes: adapter.scopes })` | `createRoot(def, { plugins: [adapter.plugin] })` |

**router.** `createRouterAdapter()` returns `{ plugin, Bridge }`. The plugin provides `RouteParamsScope`, `RouteSearchScope` and `RoutePathnameScope` to the root it is installed on. `ROUTER_PLUGIN_NAME` is exported.

**persist.** `throttleMs` is documented as what it always was: a trailing throttle, at most one write per window, carrying the latest value.

**zod.** `createZodForm`'s `initial` also accepts a function. The form tracks it the way `createForm` tracks a function `initial`, so a form seeded from a query re-seats when the data arrives. `resetOnInitialChange` passes through.

**mutation-queue.** The queue writes a run's entry before the run's first `mutate` call, from `wrapMutate`. A reload during the request no longer loses the run. The write adds one storage round trip before the first request. A write that fails is reported through `onWarn`, and the run proceeds without durability, as before.

**core.** `MutateContext.origin` names the plugin that started a run through `host.mutations.run`, or is `undefined` for an app run. A run whose `mutate` resolved and whose abort landed in the same tick reported both `success` and `cancel` to plugins. It now reports `success` only.

**react.** Streamed hydration reached only the first `HydrationBoundary`: a second boundary, or a StrictMode remount's new root, took the intake away from it. Every installed root now receives the batches that already arrived and each one that follows.
