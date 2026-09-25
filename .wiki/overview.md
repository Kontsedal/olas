---
name: overview
description: One-page architecture of the whole repo — the fourteen published packages, the core module map, and how controllers, the query engine and plugins fit.
type: overview
covers:
  - SPEC.md
  - packages/core/src
  - packages/zod/src
  - packages/persist/src
  - packages/react/src/index.ts
  - packages/vue/src/index.ts
  - packages/svelte/src/index.ts
  - packages/devtools/src/index.ts
  - packages/cross-tab/src/index.ts
  - packages/entities/src/index.ts
  - packages/realtime/src/index.ts
  - packages/mutation-queue/src/index.ts
  - packages/router/src/index.ts
  - packages/eslint-plugin/src/index.ts
  - packages/codemod/src/index.ts
  - .github/workflows/ci.yml
edges:
  - { type: documented-in, target: ../SPEC.md }
  - { type: related, target: glossary.md }
  - { type: related, target: decisions/root-handle-separate.md }
  - { type: related, target: decisions/plugin-host-v2.md }
  - { type: related, target: flows/plugin-lifecycle.md }
  - { type: related, target: decisions/ctx-primitives-are-free-functions.md }
last_verified: 2026-09-25
confidence: medium
---

# Olas — Architecture overview

**What Olas is.** A controller-tree library for browser apps. All business logic lives in a tree of pure TypeScript controllers; UI is a thin renderer that subscribes to them. SPEC.md is the authoritative design — every section below cites it.

## The 30-second model

```
createRoot(rootDef, { deps, queries: queryEngine(), plugins })
   ↓
Root handle: { api, dispose, suspend, resume, dehydrate, hydrate,
               waitForIdle, bindQuery, inject, debug }
   ↓
ControllerInstance (root)
  ├── ctx — the tree and the lifetime of this controller
  ├── child controllers (ctx.child / attach / collection / lazyChild)
  ├── reactive state (createField / createForm / createFieldArray (ctx, …))
  ├── async data (createCache / createQuery (ctx, …))
  ├── writes (createMutation (ctx, …))
  ├── events (ctx.emitter / ctx.on)
  └── lifecycle hooks (ctx.onDispose / onSuspend / onResume)

Everything reactive flows through Signal<T> (wrapper around @preact/signals-core).
```

The root controller's factory result is `root.api`, and the rest of the handle is the root's own surface (`decisions/root-handle-separate.md`). The primitives that build owned things take `ctx` as their first argument rather than hanging off it (`decisions/ctx-primitives-are-free-functions.md`). Spec §1–3 describe the principles; §20 declares the full type-level API; §21 documents the internal architecture this implementation follows.

## Packages

Fourteen packages publish to npm. `packages/integration` is a private cross-package test suite.

| Package | Purpose |
|---------|---------|
| `@kontsedal/olas-core` | Signals, controllers, the query engine (`queryEngine`, queries, infinite queries, mutations), forms, scopes, `createSelection`, SSR and streaming SSR (`serializeForScript`), the plugin host (`definePlugin`), and the devtools event bus. `/testing` adds `createTestController`, `mockFetchPlugin` and `createPluginRecorder` |
| `@kontsedal/olas-react` | `OlasProvider`, `useRoot`, `useValue`/`useQuery`/`useInfiniteQuery`/`useSuspenseQuery`/`useField`/`useFieldInput`/`useMutation`, `SuspendOnUnmount`, `useSuspendOnHidden`, `HydrationBoundary` + streaming hydrator. Runs under `preact/compat` |
| `@kontsedal/olas-vue` | `olasPlugin`, `useRoot`, `useValue`/`useQuery`/`useInfiniteQuery`/`useField`/`useMutation`: signals as read-only refs |
| `@kontsedal/olas-svelte` | `setRoot`/`getRoot` plus `queryStore`/`infiniteQueryStore`/`fieldStore`/`mutationStore`; a signal is a Svelte store as it is |
| `@kontsedal/olas-zod` | `zodValidator` + `zodValidatorAsync` + `rootOnlyZodValidator` + `createZodForm` (takes `{ initial, extraValidators }`) |
| `@kontsedal/olas-persist` | `createPersisted` + `localStorageAdapter()` + `indexedDbAdapter()` + `clearPersisted`, and the `persistQueryCachePlugin` plugin with `restoreQueryCache` |
| `@kontsedal/olas-devtools` | `<DevtoolsPanel>` + `<DevtoolsLauncher>` + `DevtoolsStore` over `root.debug` |
| `@kontsedal/olas-cross-tab` | `crossTabPlugin` — a BroadcastChannel plugin that mirrors the app's own writes and invalidations for queries with `meta: { crossTab: true }`, with a `validate` option for incoming messages |
| `@kontsedal/olas-entities` | `defineEntity` + `entitiesPlugin({ entities })` — a normalized entity store, provided as the `Entities` scope (`ctx.inject(Entities)`), with reverse-index backprop into regular and infinite queries |
| `@kontsedal/olas-realtime` | `createRealtimePatcher` + `createLiveStream` + `createConnectionState` over a consumer-supplied `RealtimeService` |
| `@kontsedal/olas-mutation-queue` | `mutationQueuePlugin({ storage })` — durable persist and reload-safe replay for mutations with `meta: { persist: true }`, controlled through the `MutationQueue` scope |
| `@kontsedal/olas-router` | `createRouterAdapter()` returns `{ plugin, Bridge }`; the plugin provides the `RouteParamsScope`/`RouteSearchScope`/`RoutePathnameScope` scopes — TanStack Router / React Router v6 |
| `@kontsedal/olas-eslint-plugin` | Eight syntax-only lint rules, with `recommended` and `strict` flat configs (`modules/eslint-plugin.md`) |
| `@kontsedal/olas-codemod` | `npx @kontsedal/olas-codemod 1.0`: the 0.8 → 1.0 migration on ts-morph (`modules/codemod.md`) |

Docs and examples: a README for every published package, `MIGRATING.md`, `RECIPES.md`, `PLUGINS.md` (the plugin authoring guide), and TSDoc. Five runnable example apps: kanban as the flagship, plus stock-ticker, reader-ssr, virtualized-table and vue-tasks. The integration suite includes an adapter-parity run of one set of scenarios through React, `preact/compat`, Vue and Svelte (`decisions/framework-adapters.md`).

## Core module map

```
packages/core/src/
├── signals/        # Reactive primitives. The ONLY consumer of @preact/signals-core.
├── controller/     # defineController, createRoot and the root handle, ControllerInstance, Ctx
├── query/          # queryEngine, QueryClient, Entry, defineQuery, createQuery, mutations, infinite, SSR
├── plugin/         # OlasPlugin / PluginHost types, PluginSet, definePlugin
├── forms/          # Field, Form, FieldArray, createField/createForm/createFieldArray, stdlib validators
├── timing/         # debounced(signal), throttled(signal)
├── scope.ts        # defineScope
├── selection.ts    # createSelection
├── html.ts         # serializeForScript
├── brand.ts        # BRAND / PHANTOM / INTERNAL symbol keys (not exported)
├── expiry-timer.ts # scheduleExpiry: Infinity-safe, chunked timers
├── emitter.ts      # createEmitter (standalone); ctx.emitter wraps it
├── devtools.ts     # DevtoolsEmitter + DebugEvent union
├── errors.ts       # ErrorContext, dispatchError
├── utils.ts        # isAbortError and internal helpers
├── index.ts        # public entry — re-exports
├── testing.ts      # sub-path: createTestController, fakes, test plugins
└── test-plugins.ts # mockFetchPlugin, createPluginRecorder
```

See `modules/*.md` for per-directory details.

## How the pieces fit

**Lifecycle is owned by `ControllerInstance`.** Every `ctx.*` method and every ctx-taking function registers a `LifecycleEntry` (effect, cleanup, child, subscription and hooks). Dispose iterates reverse; suspend disposes effects but recurses to children; resume re-instantiates effects via stored factories. See `flows/construction-rollback.md`.

**Async data is shared per-root through `QueryClient`.** A root gets a client only when `createRoot` receives `queries: queryEngine()`, so a root without one leaves the cache engine out of the bundle. `defineQuery` produces a module-scoped value with a required `id`, branded `'query'` or `'infiniteQuery'`. The query value carries a `__clients: Set<QueryClient>` so unbound query operations can detect ambiguous roots. Use `bindQuery(ctx, query)` or `root.bindQuery(query)` to select one root explicitly. `createQuery(ctx, query, keyFn)` binds a subscription through the controller's root client. See `modules/query.md`, `entities/query-client.md` and `flows/query-subscription.md`.

**Mutations dispatch by concurrency mode.** `parallel`, `latest-wins` and `serial`. Optimistic updates use a per-entry snapshot stack with positional rollback semantics (§6.4). See `flows/mutation-concurrency.md`.

**Plugins are per-root definitions.** An `OlasPlugin` is `{ name, setup(host) }`. `createRoot` runs each `setup` once, in order, before the root factory, and disposes them in reverse. The host offers `deps`, `provide`, `queries`, `mutations`, `network`, `track`, `reportError`, `onDispose` and `debug`. A plugin exposes a service through `provide`, as a scope, and `queries` and `mutations` are `null` without an engine. `setup` returns the observation hooks `onWrite`, `onInvalidate`, `onRemove`, `onActivate`, `onDeactivate` and `onMutation`, the middleware `wrapFetch` and `wrapMutate`, and `dispose`. Every write carries an `origin`, which makes echo prevention generic. Plugin settings live on `meta`, typed by each plugin augmenting `QueryMeta` or `MutationMeta`. See `decisions/plugin-host-v2.md` and `flows/plugin-lifecycle.md`.

**Forms aggregate via computed.** `Form.value`, `errors`, `isValid`, etc. are computeds that traverse the schema. Children can be `Field`, nested `Form`, or `FieldArray`, and each is a `ReadSignal` of its value. Brand markers distinguish them at runtime where they differ. See `decisions/forms-are-read-signals.md`.

**SSR is dehydrate and hydrate of the query cache only.** Controller state isn't serialized — controllers reconstruct from props on the client. `root.waitForIdle()` waits on per-entry `isFetching` signals, the `mutationsInflight$` counter on the QueryClient, and work plugins `track`. `root.hydrate(state)` applies a payload to a running root. See `flows/ssr.md` and `decisions/trust-model.md`.

**Devtools read one bus.** `root.debug.subscribe(handler)` delivers every `DebugEvent`, and `root.debug.queryEntries()` snapshots the cache. Emission is dev-only. See `modules/devtools.md`.

## The hard parts (read these pitfalls)

- [pitfalls/callargs-vs-keyargs.md](pitfalls/callargs-vs-keyargs.md) — the two-args distinction inside `ClientEntry`
- [pitfalls/latest-wins-rollback-order.md](pitfalls/latest-wins-rollback-order.md) — order matters for stacked optimistic updates
- [decisions/forms-are-read-signals.md](decisions/forms-are-read-signals.md) — every form node is a `ReadSignal` of its value

## Build & verify

The packages build ESM only (`decisions/esm-only-build.md`). CI (`.github/workflows/ci.yml`) runs install → build → typecheck → lint → `check:doc-snippets` → `test:coverage` → the examples' tests → publint → attw → `smoke:dist` → `check:public-types` → `api:check` → size. A second job runs the dist smoke on Node 20.19, 22 and 24. On 2026-09-25 the root `pnpm test` ran 2,232 tests across 176 files, including the cross-package `packages/integration` suite. The example apps ship their own controller-level tests on top. See `../CLAUDE.md` for the full command list.
