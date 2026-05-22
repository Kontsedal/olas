---
name: overview
description: One-page architecture of the whole repo — what's where and how the pieces fit.
type: overview
covers:
  - SPEC.md
  - packages/core/src
  - packages/zod/src
  - packages/persist/src
edges:
  - { type: documented-in, target: ../SPEC.md }
  - { type: related, target: glossary.md }
last_verified: 2026-05-22
confidence: high
---

# Olas — Architecture overview

**What Olas is.** A controller-tree library for browser apps. All business logic lives in a tree of pure TypeScript controllers; UI is a thin renderer that subscribes to them. SPEC.md is the authoritative design — every section below cites it.

## The 30-second model

```
createRoot(rootDef, { deps })
   ↓
ControllerInstance (root)
  ├── ctx — primitive factory bound to this controller's lifetime
  ├── child controllers (ctx.child)
  ├── reactive state (ctx.field / ctx.form / ctx.fieldArray)
  ├── async data (ctx.cache / ctx.use)
  ├── writes (ctx.mutation)
  ├── events (ctx.emitter / ctx.on)
  └── lifecycle hooks (ctx.onDispose / onSuspend / onResume)

Everything reactive flows through Signal<T> (wrapper around @preact/signals-core).
```

Spec §1–3 describe the principles; §20 declares the full type-level API; §21 documents the internal architecture this implementation follows.

## Packages

| Package | Status | Purpose |
|---------|--------|---------|
| `@kontsedal/olas-core` | Implemented | Signals, controllers, queries, mutations, forms, scopes, SSR + streaming SSR, devtools event bus, `defineScope` |
| `@kontsedal/olas-react` | Implemented | `OlasProvider`, `useRoot`, `useController`, `use`/`useQuery`/`useSuspenseQuery`/`useField`/`useFieldInput`/`useMutation`, `KeepAlive`, `useSuspendOnHidden`, `HydrationBoundary` + streaming hydrator |
| `@kontsedal/olas-zod` | Implemented | `zodValidator` + `zodValidatorAsync` + `rootOnlyZodValidator` + `formFromZod` (takes `{ extraValidators }`) |
| `@kontsedal/olas-persist` | Implemented | `usePersisted` + `localStorageAdapter` + `indexedDbAdapter` |
| `@kontsedal/olas-devtools` | Implemented | `<DevtoolsPanel>` + `<DevtoolsLauncher>` + `DevtoolsStore` over `root.__debug` |
| `@kontsedal/olas-cross-tab` | Implemented | `crossTabPlugin` — BroadcastChannel-backed cache sync (`QueryClientPlugin`) |
| `@kontsedal/olas-entities` | Implemented | `defineEntity` + `entitiesPlugin` — normalized entity store with reverse-index backprop into both regular AND infinite queries |
| `@kontsedal/olas-realtime` | Implemented | `useRealtimePatcher` + `useLiveStream` over a consumer-supplied `RealtimeService` |
| `@kontsedal/olas-mutation-queue` | Implemented | `mutationQueuePlugin` — durable persist + reload-safe replay for `defineMutation({ persist: true })` |
| `@kontsedal/olas-router` | Implemented | `createRouterAdapter` + `RouteParams/Search/Pathname` scopes — TanStack Router / React Router v6 |

Polish & docs landed: READMEs (every published package), `MIGRATING.md`, `RECIPES.md`, TSDoc, four runnable example apps (kanban flagship, stock-ticker, reader-ssr, virtualized-table), a cross-package `packages/integration` test suite. A browser-extension wrapper around the same `root.__debug` bus is the remaining stretch item.

## Core module map

```
packages/core/src/
├── signals/        # Reactive primitives. The ONLY consumer of @preact/signals-core.
├── controller/     # defineController, createRoot, ControllerInstance, Ctx
├── query/          # Entry state machine, QueryClient, defineQuery, ctx.use, mutations, infinite, SSR
├── forms/          # Field, Form, FieldArray, stdlib validators
├── timing/         # debounced(signal), throttled(signal)
├── emitter.ts      # createEmitter (standalone); ctx.emitter wraps it
├── devtools.ts     # DevtoolsEmitter + DebugEvent union
├── errors.ts       # ErrorContext, dispatchError
├── utils.ts        # isAbortError
├── index.ts        # public entry — re-exports
└── testing.ts      # sub-path: createTestController
```

See `modules/*.md` for per-directory details.

## How the pieces fit

**Lifecycle is owned by `ControllerInstance`.** Every `ctx.*` primitive registers a `LifecycleEntry` (effect / cleanup / child / on-subscription / hooks). Dispose iterates reverse; suspend disposes effects but recurses to children; resume re-instantiates effects via stored factories. See `flows/construction-rollback.md`.

**Async data is shared per-root through `QueryClient`.** `defineQuery` produces a module-scoped value branded `__olas: 'query' | 'infiniteQuery'`. The query value carries a `__clients: Set<QueryClient>` so `query.invalidate()` reaches every root. `ctx.use(query, keyFn)` binds a subscription through the controller's root client. See `entities/query-client.md` and `flows/query-subscription.md`.

**Mutations dispatch by concurrency mode.** `parallel` / `latest-wins` / `serial`. Optimistic updates use a per-entry snapshot stack with positional rollback semantics (§6.4). See `flows/mutation-concurrency.md`.

**Forms aggregate via computed.** `Form.value`, `errors`, `isValid`, etc. are computeds that traverse the schema. Children can be `Field` (a `ReadSignal<T>` plus form metadata), nested `Form`, or `FieldArray`. Brand markers distinguish them at runtime. See `pitfalls/field-value-shape.md`.

**SSR is dehydrate / hydrate of the query cache only.** Controller state isn't serialized — controllers reconstruct from props on the client. `waitForIdle()` waits on per-entry `isFetching` signals plus a `mutationsInflight$` counter on the QueryClient.

## The hard parts (read these pitfalls)

- [pitfalls/callargs-vs-keyargs.md](pitfalls/callargs-vs-keyargs.md) — the two-args distinction inside `ClientEntry`
- [pitfalls/latest-wins-rollback-order.md](pitfalls/latest-wins-rollback-order.md) — order matters for stacked optimistic updates
- [pitfalls/field-value-shape.md](pitfalls/field-value-shape.md) — `Field.value` and `Form.value` are differently shaped

## Build & verify

CI = `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build`. 621 tests across 55 files pass (including the cross-package `packages/integration` suite; example apps ship their own controller-level tests on top). See `../CLAUDE.md` for the full command list.
