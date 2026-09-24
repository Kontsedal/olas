# Migrating to Olas

Notes for upgrading from 0.8, and for users coming from TanStack Query, Redux Toolkit, or "hooks at the top of a page". The later sections are not a complete tutorial — they are a Rosetta Stone that maps familiar concepts to Olas equivalents.

`SPEC.md §1–3` covers the philosophy in depth; the spec is the source of truth for the type-level shape.

---

## Upgrading from 0.8 to 1.0

1.0 is one step from 0.8, and every package takes it together. Most of the change is renames and moved options, and a codemod makes those. The rest is below, each with its fix.

### 1. Run the codemod

```bash
npx @kontsedal/olas-codemod 1.0
```

Before you run it:

- **Start from a clean git tree.** The codemod edits files in place, and `git diff` is how you review what it did.
- **Keep the 0.8 packages installed.** The type-driven rewrites recognize the 0.8 types, such as a root with `__debug`, or a form whose `value` is a signal. Against the 1.0 types they find nothing. Upgrade the packages after the codemod has run.
- **Run it once.** A second run can undo part of the first.
- **Run your formatter after it.** The codemod appends the imports it adds without sorting them.

Then review the diff, upgrade the packages, and typecheck against 1.0: the compiler finds what neither the codemod nor its TODO list saw. The codemod prints a TODO list of the sites it found and did not rewrite, as `file:line — transform: what to do`. [Finish the TODO list](#3-finish-the-todo-list) covers each kind. `--dry` prints the summary and the TODOs and writes nothing, and `--tsconfig <path>` points at the project that includes your sources. [`packages/codemod/README.md`](packages/codemod/README.md) lists every transform and every TODO category.

### 2. What changed

The third column says what the codemod does with each row: **rewrites** it, **flags** it on the TODO list, or leaves it to you (—).

#### The root

| 0.8 | 1.0 | Codemod |
|---|---|---|
| `root.increment()`: the api was spread onto the root | `root.api.increment()`. The root is a handle: `api`, `dispose`, `suspend`, `resume`, `dehydrate`, `hydrate`, `waitForIdle`, `bindQuery`, `inject` and `debug` | rewrites |
| `root.__debug` | `root.debug` | rewrites |
| `root.applyDehydratedEntry(id, key, data, at)` | `root.hydrate(state)`, which takes a whole `DehydratedState` | flags |
| `root.suspend({ maxIdle })` | `root.suspend({ maxIdleTime })` | rewrites |
| `createRoot(app, { deps })`, which always built a query client | `createRoot(app, { deps, queries: queryEngine() })`. A root whose controllers create a query, a mutation or a bound query needs the engine | rewrites: every root gains one, which a root with no queries can drop |
| `defaultQueryOptions`, `refetchOnWindowFocus` and `refetchOnReconnect` on the root options | `queries: queryEngine({ defaults: { … } })`. `plugins` and `hydrate` stay on the root options | rewrites |
| `DefaultQueryOptions` | `QueryDefaults` | rewrites |
| `createTestController(def, { deps, props, defaultQueryOptions })`, returning the api with the controls mixed in | the handle `createRoot` returns: `const { api } = createTestController(def, { deps })`. `props` is optional for a controller without props, and defaults go in `queries: queryEngine({ defaults })` | rewrites |

#### Controllers and `ctx`

| 0.8 | 1.0 | Codemod |
|---|---|---|
| `ctx.field`, `ctx.form`, `ctx.fieldArray`, `ctx.cache`, `ctx.use`, `ctx.mutation` | `createField`, `createForm`, `createFieldArray`, `createCache`, `createQuery`, `createMutation`, imported from core and called with `ctx` first: `ctx.field<string>('')` becomes `createField<string>(ctx, '')` | rewrites |
| `ctx.signal`, `ctx.computed` | `signal`, `computed` from core | rewrites |
| `ctx.field(initial, [validators], { validateOn })` | `createField(ctx, initial, { validators, validateOn })` | rewrites |
| `ctx.session(def, props)`, returning `[api, dispose]` | `ctx.attach(def, props)`, returning `{ api, dispose, suspend, resume }` | flags |
| `selection()` | `createSelection()`. `isSelected(id)` returns the same signal for the same id | rewrites |

`ctx` keeps the members that bind to the controller's tree and lifetime: `emitter`, `child`, `attach`, `collection`, `lazyChild`, `effect`, `on`, `provide`, `inject`, `debug`, `deps` and the lifecycle hooks.

#### Queries

| 0.8 | 1.0 | Codemod |
|---|---|---|
| `queryId`, optional | `id`, required on `defineQuery` and `defineInfiniteQuery` | rewrites. A query with no `queryId` gets a placeholder `id` and a TODO |
| `crossTab: true` or `'data'` on a query | `meta: { crossTab: true }`, typed by `@kontsedal/olas-cross-tab` | rewrites |
| `createCache(ctx, (signal) => …)` | `createCache(ctx, ({ signal, deps }) => …)` | rewrites |
| `subscription.promise()` | `subscription.firstValue()` | rewrites |
| `UseOptions` | `QuerySubscriptionOptions` | rewrites |
| `ErrorContext.queryKey` | `ErrorContext.key`, next to `ErrorContext.queryId` | rewrites |
| `query.__olas`, `scope.__id` and the other `__` fields | symbol keys that core does not export. Keep a reference to the definition instead of reading its kind | — |

#### Mutations

| 0.8 | 1.0 | Codemod |
|---|---|---|
| `mutationId` and `name` | `id`. Required on `defineMutation`; optional on an inline `createMutation` spec, where it is also the devtools label | rewrites |
| `persist: true`, and a `defineMutation` that persisted by default | `meta: { persist: true }`, typed by `@kontsedal/olas-mutation-queue`. Nothing persists by default | rewrites, keeping 0.8's default |
| `mutate: (vars, signal) => …` | `mutate: (vars, { signal, deps }) => …` | rewrites |
| `createMutation(ctx, { ...defined, onSuccess })` | `createMutation(ctx, defined, { onSuccess })`. `defineMutation` takes no hooks | rewrites. Hooks on a definition get a TODO |
| `MutationDisposedError.mutationName` | `MutationDisposedError.mutationId` | rewrites |

#### Forms

| 0.8 | 1.0 | Codemod |
|---|---|---|
| `form.value.value`, `fieldArray.value.value` | `form.value`, `fieldArray.value`. A `Form` and a `FieldArray` are `ReadSignal`s of their value, like a `Field` | rewrites |
| `use(form.value)` | `useValue(form)` | rewrites |
| `form.resetWithInitial(partial)` | `form.setAsInitial(partial)` | rewrites |
| `form.submit(handler)` resolving `{ ok, data?, error? }` | resolves a `SubmitResult` union: narrow on `ok`, then on `reason` | flags a result the code reads |

#### Plugins

| 0.8 | 1.0 | Codemod |
|---|---|---|
| a `QueryClientPlugin` object with `init(api)` and `onSetData` | `definePlugin({ name, setup(host) { return hooks } })`. See [Custom plugins](#custom-plugins) | flags the imports |
| `stableHash`, `lookupRegisteredQuery`, `lookupRegisteredMutation`, `RegisteredQuery`, `RegisteredMutation` | internal. A plugin uses `host.queries.hashKey`, `host.queries.get` and `host.mutations.run` | flags |
| `isStandardSchema`, `ErrorContextInput` | no longer exported | flags |

#### React

| 0.8 | 1.0 | Codemod |
|---|---|---|
| `use(signal)` | `useValue(signal)`. `use` shadowed React 19's `React.use` | rewrites |
| `KeepAlive` | `SuspendOnUnmount`, which it aliased | rewrites |
| `useController(root)` | `root.api` | rewrites |
| `useMutation`'s `mutate` and `mutateAsync`, which both returned the promise | `mutate(vars)` returns nothing, and a failure lands on `error` and `status`. `run(vars)` returns the promise | rewrites an awaited call to `run`. Flags a `mutate` whose caller may await it |
| `useQuery` returned part of the state | the whole state, including `isPaused`, `isEnabled`, `reset` and `cancel`. A component re-renders only for the fields it reads | — |
| `useMutation`'s `onError` and `onSettled` fired for an aborted run | they skip a run that a `latest-wins` supersede, `reset()` or dispose aborted | — |
| `useRoot<Api>()` | still works. A `Register` augmentation types `useRoot()` with no argument | — |

#### The other packages

| 0.8 | 1.0 | Codemod |
|---|---|---|
| persist `usePersisted` | `createPersisted` | rewrites |
| persist `localStorageAdapter`, an object | `localStorageAdapter()`, a factory like `indexedDbAdapter()` | rewrites |
| persist `clearPersisted(storage, prefix, onError)` | `clearPersisted(storage, { prefix, onError })`, or `{ all: true }`. With neither it throws | rewrites. A call with no prefix becomes `{ all: true }` and a TODO |
| realtime `useRealtimePatcher`, `useLiveStream`, `useRealtimeConnection` | `createRealtimePatcher`, `createLiveStream`, `createConnectionState` | rewrites |
| zod `formFromZod(ctx, schema, { initials })`, `FormFromZodOptions` | `createZodForm(ctx, schema, { initial })`, `ZodFormOptions` | rewrites |
| entities `entitiesPlugin([Post])` | `entitiesPlugin({ entities: [Post] })` | rewrites |
| entities: the plugin value was the store | the store is a per-root service: `ctx.inject(Entities)` or `root.inject(Entities)` | flags |
| entities `store.invalidate` | `store.remove`, because it never refetched | rewrites |
| mutation-queue `mutationQueuePlugin({ adapter })` | `mutationQueuePlugin({ storage })` | rewrites |
| mutation-queue `plugin.replayNow()` | `ctx.inject(MutationQueue).replayNow()` | flags |
| mutation-queue `onReplaySettle(entry, result, api)`, with `api.invalidate(query, args)` | the third argument is the root's `QueryHost`: `queries.invalidate(id, key)` | flags |
| router `createRoot(app, { scopes: adapter.scopes })` | `createRoot(app, { plugins: [adapter.plugin] })` | rewrites |
| cross-tab: one plugin instance per root, mirroring other plugins' writes along with the app's | one definition serves any number of roots, and it mirrors only the app's own writes by default | — See [Cross-tab](#cross-tab-mirrors-the-apps-own-writes) |

#### Packaging

| 0.8 | 1.0 | Codemod |
|---|---|---|
| CommonJS and ES module builds | ES modules only, on Node 20.19 or later. A CommonJS consumer can still `require()` the packages there | — |

### 3. Finish the TODO list

| TODO | Fix |
|---|---|
| `ctx.session` | `const { api, dispose } = ctx.attach(def, props)`. The handle also has `suspend` and `resume` |
| `root.applyDehydratedEntry(id, key, data, at)` | `root.hydrate({ version: 1, entries: [{ id, key, data, lastUpdatedAt: at }] })` |
| `useController` used as a value | pass `root.api` |
| the old plugin types and helpers | port the plugin: see [Custom plugins](#custom-plugins) |
| a `form.submit(...)` whose result the code reads | switch on `result.ok`, then on `result.reason` (`'invalid'`, `'busy'`, `'disposed'` or `'error'` with `result.error`) |
| a `mutate(...)` in an arrow body outside a JSX handler | if its caller awaits the promise, call `run(...)` instead |
| the entity store read from the plugin value | `ctx.inject(Entities)` in a controller, `root.inject(Entities)` outside one |
| `replayNow()` on the queue plugin | `ctx.inject(MutationQueue).replayNow()`, or `root.inject(MutationQueue)` |
| an `onReplaySettle` that uses its third argument | it is a `QueryHost` now, addressed by query `id` and entry key. The key is the `key(...)` output, not the call arguments |
| hooks on a `defineMutation` | move them to the owning controller: `createMutation(ctx, def, { onSuccess, … })` |
| options, specs or fetchers passed through a variable | apply the table above to the value by hand |
| a spread of a root, or destructuring that mixes root controls with api members | read the api from `root.api`, and the controls from `root` |
| a local `signal`, `createField` or `queryEngine` in the way of an import | rename the local |
| a placeholder query `id` (`'<path>:<line>'`) | pick a stable, unique id that is the same in the server and client bundles |
| a `clearPersisted` kept at `{ all: true }`, or with a prefix that may be empty | narrow it to your app's prefix, unless you mean every key the adapter holds |

### 4. What the codemod leaves to you

These changes are not mechanical. The codemod neither rewrites nor reports them, so read each one against your code.

#### Custom plugins

The plugin contract was redesigned. A plugin is a definition now, and `createRoot` runs its `setup(host)` once per root, before the root controller's factory. Per-root state lives in `setup`'s closure, so one plugin value serves any number of roots.

```ts nocheck
// 0.8
const audit: QueryClientPlugin = {
  name: 'audit',
  init(api) {
    pluginApi = api
  },
  onSetData(event) {
    if (event.isRemote) return
    log(event.queryId, event.keyArgs, event.source)
  },
  onMutationSettle(event) {
    log(event.mutationId, event.outcome)
  },
}
```

```ts
// 1.0
import { createRoot, definePlugin, queryEngine } from '@kontsedal/olas-core'
import { appController } from './app.controller'

export const audit = definePlugin({
  name: 'audit',
  setup(host) {
    return {
      onWrite(event) {
        if (event.origin !== undefined) return // written by a plugin, not the app
        host.debug({ query: event.query.id, key: event.key, source: event.source })
      },
      onMutation(event) {
        if (event.phase !== 'start') host.debug({ mutation: event.mutation.id, phase: event.phase })
      },
    }
  },
})

const root = createRoot(appController, { deps: {}, queries: queryEngine(), plugins: [audit] })
```

The pieces map like this:

| 0.8 | 1.0 |
|---|---|
| `init(api)` | `setup(host)`, which returns the hooks |
| `onSetData`, with `source: 'set' \| 'fetch' \| 'remote'` and `isRemote` | `onWrite`, with `source` one of `'fetch'`, `'hydrate'`, `'optimistic'`, `'rollback'`, `'write'` and `'replace'`, and `origin`: the name of the plugin that wrote, or `undefined` for the app |
| `onGc` | `onRemove` |
| `onMutationEnqueue`, `onMutationSettle` (persisted mutations only) | `onMutation`, for every run: `start`, then one of `success`, `error` and `cancel` |
| `api.applyRemoteSetData`, `api.setEntryData` | `host.queries.write(id, key, updater)`, or `replace(id, key, value)` for a whole record |
| `api.applyRemoteInvalidate` | `host.queries.invalidate(id, key)` |
| `api.subscribedKeys(id)` | `host.queries.keys(id)`, every key the root holds for the query |
| `stableHash(key)` | `host.queries.hashKey(key)` |
| a plugin value that doubled as a service | `host.provide(scope, value)`, read with `ctx.inject(scope)` |

New in 1.0: `wrapFetch` and `wrapMutate` middleware, `onActivate` and `onDeactivate`, `host.track(promise)` for work `root.waitForIdle()` should wait for, and `host.network`. A plugin works without a query engine, where `host.queries` is `null`. [`PLUGINS.md`](PLUGINS.md) is the authoring guide, and `mockFetchPlugin` and `createPluginRecorder` in `@kontsedal/olas-core/testing` help test one.

#### Unbound query helpers pick a root

A query's own helpers, such as `userQuery.write`, `peek`, `cancel`, `invalidate` and `prefetch`, now throw, or reject their promise, once more than one root has touched the query. In 0.8 they broadcast writes to every root, or read whichever root came first. With one root they are still shortcuts. With no root, they do nothing and `peek` returns `undefined`, except `prefetch`, which rejects.

Use a bound handle in controllers and request handlers:

<!-- snippet-prelude
import type { Root } from '@kontsedal/olas-core'
declare const root: Root<unknown>
-->
```ts
import { bindQuery, createQuery, defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

const feature = defineController((ctx) => {
  const users = bindQuery(ctx, userQuery)
  const user = createQuery(ctx, userQuery, () => ['me'])
  return {
    user,
    rename: (name: string) => users.write('me', (prev) => ({ ...prev!, name })),
  }
})

// Outside a controller, including a request-specific SSR handler:
await root.bindQuery(userQuery).prefetch('me')
```

Binding does not subscribe or fetch, and it works before the first subscription. The handle exposes the query's imperative methods with their argument and result types, and stays tied to its root: its operations fail after that root is disposed. For an intentional broadcast, iterate the roots and use each one's bound handle.

**The sharpest edge is `peek`.** In 0.8 it neither threw nor warned. That was deliberate, because `peek` sits in click handlers, event folds and other hot paths where a warning would fire constantly. In 1.0 it is guarded like every other unbound operation. So an unbound `peek` in one of those paths now *throws* anywhere two roots coexist. That covers a test file that builds several roots, a micro-frontend, and a root swap where the outgoing root has not disposed yet. This is intentional, because reading from an arbitrary root is how the wrong user's data reaches the screen. It is also the change most likely to surface at runtime rather than at the type level. Audit `peek` call sites first, and bind them.

#### Cross-tab mirrors the app's own writes

`crossTabPlugin` mirrors only writes whose `origin` is `undefined`, meaning the app made them. In 0.8 it mirrored other plugins' writes as well. The entities plugin's backprop was one: every tab derives it on its own, so each patch crossed the channel once per tab. To mirror another origin's writes, name it: `crossTabPlugin({ channelName, origins: [ENTITIES_PLUGIN_NAME] })`. An origin is a plugin's name, or the one a `bindQuery(ctx, query, { origin })` handle was given. Tagging a realtime handler's handle that way keeps a push that every tab receives off the channel.

`optimistic: false` mirrors only canonical writes. The new `validate(queryId, data)` option rejects a peer payload of a shape this tab does not expect. Infinite queries with `meta: { crossTab: true }` sync too, with their page params.

#### Nothing persists by default

A 0.8 `defineMutation` persisted every run to the mutation queue unless it said otherwise. In 1.0 a run persists only with `meta: { persist: true }`. The codemod adds that to every `defineMutation` that did not set `persist`, to keep 0.8's behavior. Review each one: a write that makes no sense to replay after a reload should drop it. The queue also replays only a mutation whose definition has `meta.persist`, so an entry stored for any other registered mutation is not run.

#### Typed `useRoot()`

`useRoot<Api>()` still works, as an unchecked cast at each call site. Register the root's type once and `useRoot()` needs no type argument:

<!-- snippet-prelude
import type { Root } from '@kontsedal/olas-core'
declare const root: Root<unknown>
-->
```ts
declare module '@kontsedal/olas-react' {
  interface Register {
    root: typeof root
  }
}
```

`@kontsedal/olas-vue` and `@kontsedal/olas-svelte` each export a `Register` of their own, augmented the same way.

#### A root read through a type query or an element access

`typeof root.count` and `root['count']` stay as they are. Rewrite them to `typeof root.api.count` and `root.api['count']`.

#### Serialized queries: stable ids

Every query has a hand-written `id`, identical in the server and client bundles:

```ts file=queries.ts
import { defineQuery } from '@kontsedal/olas-core'

export type User = { id: string; name: string }

export const userQuery = defineQuery({
  id: 'users/detail',
  key: (id: string) => [id],
  fetcher: async ({ signal }, id): Promise<User> => {
    const res = await fetch(`/api/users/${id}`, { signal })
    return res.json()
  },
  staleTime: 30_000,
})
```

0.8 gave a query without a `queryId` an automatic id from the order its module defined it, and hydration matched on that id. 1.0 has no automatic ids, so a payload from a 0.8 server seeds a 1.0 client only for queries whose 0.8 `queryId` equals the 1.0 `id`. Deploy the server and the client together. `dehydrate()` now includes infinite queries, with a `pageParams` field on their entries. Fresh hydrated entries skip the refetch; `staleTime: 0` still refetches.

Inline the payload with `serializeForScript(root.dehydrate())` from core. It escapes the characters that could end the script, so data containing `</script>` stays data.

#### Cache keys and timers

Cache keys encode every value with a type tag, so `undefined`, `NaN`, a `Date` and a `bigint` no longer collide with a string or an object. Rebuild any external index that stored a key hash: `host.queries.hashKey`'s output is not a persistence protocol. `-0` in a key is `0`. Cyclic keys throw a descriptive error.

One scheduler runs every duration: staleness, gc, `refetchInterval`, the `retryDelay` backoff and `suspend({ maxIdleTime })`. `staleTime: Infinity` stays fresh until explicitly invalidated, with no expiry timer, and `gcTime: Infinity` keeps a released entry for the life of the root. Finite delays beyond the platform timer limit (2,147,483,647 ms) are scheduled in chunks instead of overflowing.

A `gcTime: Infinity` or a multi-week `gcTime` on 0.8 did the opposite of what it says. Platforms clamp an out-of-range `setTimeout` delay to 1 ms, so the entry was dropped almost immediately after its last subscriber left. Those entries now survive as intended. Expect higher steady-state cache retention, which is the documented behavior of the setting.

#### Package versions diverge after 1.0

Through 0.8 every `@kontsedal/olas-*` package shared one version number, bumped in lockstep whether or not it had changed. From 1.0 on they version independently: a release bumps only the packages it changes.

Nothing to do on your side — keep whatever versions npm resolves. Do not assume matching version numbers mean anything, and do not pin the suite to a single version. Each package declares the core range it supports as a peer dependency, so npm rejects an incompatible pairing at install time.

### Why

- **The root is a handle.** Mixing the root controls into the api reserved eight names in every app, and an api using one threw at startup. Any control added later would have broken someone. `.wiki/decisions/root-handle-separate.md` has the reasoning.
- **The `ctx` primitives are free functions.** `Ctx` was one object with every method wired eagerly, in a module that `createRoot` imports. So every app shipped the forms subsystem and the query engine. As named exports, a bundler drops what an app does not import, and a root without `queries` leaves the query client out. `.wiki/decisions/ctx-primitives-are-free-functions.md` covers it, with the naming alternatives.
- **`id` is required.** An anonymous query was silently skipped by `dehydrate()`, by every plugin and by the devtools labels. The failure was quiet: a slower page, or a sync that did not happen. See `.wiki/decisions/required-id-and-meta.md`.
- **Plugin settings live in `meta`.** `crossTab` and `persist` were core fields for features core does not implement. `QueryMeta` and `MutationMeta` are empty in core, and each plugin package adds its own fields.
- **Plugins are definitions.** A 0.8 plugin value held one root's state, needed a reuse guard, and made the query engine usable once, which broke `HydrationBoundary` under StrictMode. `.wiki/decisions/plugin-host-v2.md` lists the six problems the redesign fixes.
- **`create*` names.** A `use*` function that takes `ctx` reads as a React hook to people and to `eslint-plugin-react-hooks`, which reports it inside a controller factory.

---

## From TanStack Query (React Query)

### Mental model shift

TanStack: each component calls `useQuery(['user', id], fetchUser)` at the top of its render and lets the QueryClient hash the key.

Olas: each *controller* declares `createQuery(ctx, userQuery, () => [id])`. The query is defined once at module scope (`defineQuery`), and consumers point at it. The QueryClient still hashes — it lives on the root.

Why: in TanStack, the "subscriber" is a component; component lifetime drives subscription lifetime. In Olas, the "subscriber" is a controller; controller lifetime drives subscription lifetime. Components are just renderers. This separates "who's reading the data" from "who's drawing it on screen."

### Concept-by-concept

| TanStack Query                            | Olas                                                                  |
|-------------------------------------------|-----------------------------------------------------------------------|
| `useQuery({ queryKey, queryFn })`         | `defineQuery({ id, key, fetcher })` once + `createQuery(ctx, q, keyFn)` per subscriber |
| `useInfiniteQuery`                        | `defineInfiniteQuery` + `createQuery(ctx, infiniteQ)`; React reads it with `useInfiniteQuery(subscription)` |
| `useMutation`                             | `createMutation(ctx, { mutate, onMutate, onSuccess, onError, onSettled })`   |
| `queryClient.invalidateQueries({...})`    | `users.invalidate(...args)` or `users.invalidateAll()`, on a handle from `bindQuery(ctx, userQuery)` |
| `queryClient.setQueryData(key, updater)`  | `users.setData(...args, updater)` for an optimistic patch, `users.write(...args, updater)` for a canonical one |
| `queryClient.prefetchQuery(...)`          | `root.bindQuery(userQuery).prefetch(...args)`                          |
| `QueryClientProvider`                     | `OlasProvider` (provides the root, which owns the QueryClient)        |
| `useIsFetching`                           | Subscribe to `subscription.isFetching` directly via `useValue()`      |
| Optimistic update with rollback           | `mutation.onMutate` returns the `Snapshot` from `setData(...)`; the mutation rolls it back on error |
| `keepPreviousData: true`                  | `keepPreviousData: true` on the `defineQuery` spec (per-query, not per-subscriber) |
| `staleTime` / `gcTime`                    | Same names — per query in `defineQuery`, or app-wide via `queryEngine({ defaults })` |
| `defaultOptions: { queries: {...} }`      | `createRoot(def, { deps, queries: queryEngine({ defaults: {...} }) })` |
| `refetchOnWindowFocus`                    | Per-query option in `defineQuery`, or an engine default (off by default) |
| `meta`                                    | `meta`, typed by the plugins you install                              |
| `useQueries` for parallel queries         | Multiple `createQuery(ctx, ...)` calls in the same controller                  |
| `useSuspenseQuery`                        | `useSuspenseQuery(subscription)` from `@kontsedal/olas-react`; outside React, `subscription.firstValue()` |

### The Provider story

```tsx nocheck
// TanStack
<QueryClientProvider client={queryClient}>
  <App />
</QueryClientProvider>
```

```tsx
// Olas
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { App } from './App'
import { appController } from './app.controller'
import { deps } from './deps'

const root = createRoot(appController, { deps, queries: queryEngine() })

export const tree = (
  <OlasProvider root={root}>
    <App />
  </OlasProvider>
)
```

The Olas root owns its own QueryClient (one per root). Two roots have isolated caches — useful for tests and for unrelated sub-apps.

### Patterns that don't translate one-to-one

- **The default values differ, not only the API.** TanStack defaults to `retry: 3` and `refetchOnWindowFocus: true`; Olas defaults to `retry: 0`, `refetchOnWindowFocus: false`, `staleTime: 0`. Porting a `QueryClient` config means restating your policy in `queryEngine({ defaults })` — otherwise queries silently stop retrying and (with `staleTime: 0`) refetch on every subscribe. This is a behavior change that produces no type error, so do it first.
- **TanStack `useQuery` returns the same `data | undefined` and you handle both.** Olas `createQuery(ctx, q)` returns an `AsyncState<T>` with ten signals, plus `refetch`, `cancel`, `reset` and `firstValue`. The signals are `data`, `error`, `status`, `isLoading`, `isFetching`, `isStale`, `isPaused`, `isEnabled`, `lastUpdatedAt` and `hasPendingMutations`. In React, `useQuery(subscription)` reads them in one hook and re-renders only for the fields the component reads.
- **Suspense.** `useSuspenseQuery(subscription)` suspends until the first value lands, and `useInfiniteQuery(subscription, { suspense: true })` does the same for an infinite query. Outside React, `subscription.firstValue()` awaits the first data.
- **`mutation.reset()` cancels; TanStack's doesn't.** rq's `reset()` detaches the observer and lets the in-flight request finish. Olas aborts every in-flight run and rejects queued `serial` runs (SPEC §6.2). Same name, same signature, no type error — but a write you expected to land won't. Audit every `reset()` you port.
- **DevTools.** TanStack devtools is mature; Olas ships `@kontsedal/olas-devtools` — `<DevtoolsLauncher root={root} />` gives you a floating panel with the controller tree, a cache and mutation timeline, the cache and a search box. It runs inside the page; there is no browser extension.

---

## From Redux Toolkit (RTK / RTK Query)

### Mental model shift

RTK: one global store, slices own reducers, components select via `useSelector`. RTK Query layers `endpoints` over a slice.

Olas: no global store. The root controller is your "store" but it's a tree, and every subtree owns its state. There are no actions, no reducers, no selectors — methods on the controller's api directly mutate signals (or call mutations).

Why: actions and reducers are useful for time-travel debugging and replayable history; the cost is the indirection of `dispatch(action) → reducer → state`. Olas trades that for direct mutation of typed reactive primitives. You still get devtools-level introspection via `root.debug.subscribe(...)` (controller, cache, and mutation events).

### Concept-by-concept

| Redux Toolkit                                 | Olas                                                            |
|-----------------------------------------------|-----------------------------------------------------------------|
| `createSlice({ name, initialState, reducers })` | `defineController((ctx) => ({ signals + methods }))`            |
| `useSelector(selectFoo)`                       | `useValue(api.foo)` (signal) or `computed(() => /* derive */)`   |
| `useDispatch()` + `dispatch(slice.actions.x())` | Call methods on the controller api directly: `api.x()`         |
| `createAsyncThunk`                             | `createMutation(ctx, { mutate, onSuccess, onError })`                  |
| `createSelector` (memoized derivation)         | `computed(() => …)` (memoized automatically by signals runtime) |
| RTK Query `createApi({ endpoints })`           | `defineQuery({ id, key, fetcher })` per endpoint                |
| RTK Query `useGetXQuery(id)`                   | `createQuery(ctx, getXQuery, () => [id])`                                |
| Middleware (logger, thunk, etc.)               | A plugin (`definePlugin`) with `onWrite`, `onMutation`, `wrapFetch` and `wrapMutate`; `root.debug.subscribe(handler)` for dev events; mutations replace thunks |
| `combineReducers` / module separation          | Controller tree — each subtree is its own "slice"               |
| `useStore()`                                   | `useRoot()` (returns the root's API)                            |
| Persist via redux-persist                      | `createPersisted(ctx, key, source)` from `@kontsedal/olas-persist`           |

### Selectors vs computed

```ts nocheck
// Redux Toolkit
const selectActiveTodos = (s: State) => s.todos.filter(t => !t.done)
const selectVisibleCount = createSelector(selectActiveTodos, ts => ts.length)
const count = useSelector(selectVisibleCount)
```

```tsx
// Olas
import { computed, signal } from '@kontsedal/olas-core'
import { useValue } from '@kontsedal/olas-react'

const todos = signal<{ title: string; done: boolean }[]>([])
const activeTodos = computed(() => todos.value.filter((t) => !t.done))
const visibleCount = computed(() => activeTodos.value.length)

// in React:
export function VisibleCount() {
  const count = useValue(visibleCount)
  return <span>{count}</span>
}
```

`computed` is the same idea as `createSelector` — memoized derivation — but it's reactive (re-evaluates when dependencies change) instead of being driven by selector calls.

### Where actions help: they help less here

If you need actions (replayable history, time-travel, action logs), a plugin's `onWrite` and `onMutation` hooks see every cache write and every mutation run, and you can reconstruct externally. But for the typical "form submit fires a mutation, optimistic update, server confirms or rolls back" loop, RTK's `createAsyncThunk` is replaced by `createMutation` with `onMutate` returning the rollback context — same data flow, less boilerplate.

---

## From "hooks at the top of the page"

The path many React projects take: every feature is a `useFoo()` hook that calls `useState`, `useQuery` and `useEffect` at the top of a component, and the component renders.

This works until:
- The same logic is needed in two components.
- A "feature" has a lifecycle longer than one component mount.
- You want to test the logic without rendering.
- The `useEffect` cleanup story gets non-trivial.

Olas's answer is: extract the hook's body into a controller, expose its API, and have the component call `useRoot()` (or a feature-specific hook returning `useRoot<X>().feature`) to read the signals.

```tsx nocheck
// Before
function MyPage() {
  const [editing, setEditing] = useState(false)
  const { data: user } = useQuery(['user'], fetchUser)
  // … logic …
  return /* … */
}
```

```tsx
// After
import { createQuery, type CtrlApi, defineController, signal } from '@kontsedal/olas-core'
import { useQuery, useRoot, useValue } from '@kontsedal/olas-react'
import { userQuery } from './queries'

const myPageController = defineController((ctx) => {
  const editing = signal(false)
  const user = createQuery(ctx, userQuery, () => ['me'])
  return { editing, user, toggleEdit: () => editing.update((v) => !v) }
})

type MyPageApi = CtrlApi<typeof myPageController>

export function MyPage() {
  const page = useRoot<MyPageApi>()
  const editing = useValue(page.editing)
  const { data: user } = useQuery(page.user)
  return (
    <button type="button" onClick={page.toggleEdit}>
      {editing ? 'Done' : `Edit ${user?.name ?? ''}`}
    </button>
  )
}
```

Trade-offs: more files, more types, more setup. Payoff: lifecycle is explicit, tests don't render components, and the same controller can be driven from another framework or a CLI.

---

## When NOT to migrate

- Small apps with a few screens, no shared logic, no testable business rules. Hooks-at-the-top-of-pages is fine; don't pay the abstraction cost for nothing.
- Pure design systems and component libraries. Olas is for app logic, not UI primitives.
- Heavy mutable performance loops (canvas, animation). Signals are fast but not zero-cost; raw mutable refs win for tight inner loops. Keep them in components and commit to controllers at gesture boundaries (spec §16.5 "Gesture and transient UI state").

---

## Common confusions

**"Where does state go?"** — In a controller, as a `Signal` or `Field`. Controllers compose via `ctx.child(...)`.

**"Where does fetching go?"** — In `defineQuery` (shared across the tree) or `createCache` (private to one controller).

**"How do siblings talk?"** — Parent owns both, passes refs/signals down. No implicit lookups; spec §11.

**"Where are routes?"** — Bring your own router. Put it behind a `RouterService` in deps, or bridge TanStack Router or React Router with `@kontsedal/olas-router`. Spec §16.5.

**"Can I test without rendering?"** — Yes. `createTestController` builds a root in isolation. No DOM, no React.

---

## Further reading

- [`SPEC.md`](SPEC.md) — the authoritative design.
- [`packages/codemod/README.md`](packages/codemod/README.md) — every 0.8 → 1.0 transform, and what the codemod leaves out.
- [`PLUGINS.md`](PLUGINS.md) — writing a plugin against the 1.0 host.
- [`.wiki/overview.md`](.wiki/overview.md) — one-page architecture.
- [`.wiki/decisions/`](.wiki/decisions/) — why-this-not-that.
