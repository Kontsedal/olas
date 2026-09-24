# API Reference

Every public export across the Olas packages. Each gets one canonical entry, with its signature, what it does, a minimal example and the trade-offs. This page is the catalog. The friendly tour is [`README.md`](README.md), the design rationale is [`SPEC.md`](SPEC.md), and the known footguns are in [`.wiki/pitfalls/`](.wiki/pitfalls).

A behavior missing from both this page and SPEC.md is a docs bug. Please file it.

## Conventions used in this file

- **Signature** — copy-paste-able TypeScript signature. Generics are spelled out, optional params are marked `?`.
- **What it does** — one paragraph in plain English.
- **Example** — minimal idiomatic snippet. `pnpm check:doc-snippets API.md` typechecks every example against the current sources.
- **When to use and When not** — guidance, not rules. Used when the API has a near-neighbor it gets confused with.
- **See also** — links to spec sections, wiki pitfalls, related APIs.

`ReadSignal<T>` means a read-only signal; `Signal<T>` is read-write. Anything starting with `ctx.` is a method on the controller's `Ctx` object. The primitives a controller owns, such as fields, queries and mutations, are free functions that take `ctx` first: `createField(ctx, …)`, `createQuery(ctx, …)`. Both kinds are bound to the controller's lifetime.

---

## Table of contents

- [@kontsedal/olas-core](#olascore)
  - [Signals](#signals)
  - [Time-based signals](#time-based-signals)
  - [Controllers & roots](#controllers--roots)
  - [The `Ctx` object](#the-ctx-object)
  - [Async data — queries](#async-data--queries)
  - [Async data — infinite queries](#async-data--infinite-queries)
  - [Async data — local cache](#async-data--local-cache)
  - [Mutations](#mutations)
  - [Forms — `Field`](#forms--field)
  - [Forms — `Form`](#forms--form)
  - [Forms — `FieldArray`](#forms--fieldarray)
  - [Forms — stdlib validators](#forms--stdlib-validators)
  - [Scopes](#scopes)
  - [Emitters](#emitters)
  - [Selection](#selection)
  - [Plugins](#plugins)
  - [SSR — `dehydrate` and `hydrate`](#ssr--dehydrate-and-hydrate)
  - [Errors](#errors)
  - [Devtools event bus](#devtools-event-bus)
  - [Utilities](#utilities)
- [@kontsedal/olas-core/testing](#olascoretesting)
- [@kontsedal/olas-react](#olasreact)
- [@kontsedal/olas-vue](#olasvue)
- [@kontsedal/olas-svelte](#olassvelte)
- [@kontsedal/olas-persist](#olaspersist)
- [@kontsedal/olas-zod](#olaszod)
- [@kontsedal/olas-devtools](#olasdevtools)
- [@kontsedal/olas-cross-tab](#olascrosstab)
- [@kontsedal/olas-entities](#olasentities)
- [@kontsedal/olas-realtime](#olasrealtime)
- [@kontsedal/olas-mutation-queue](#olasmutationqueue)
- [@kontsedal/olas-router](#olasrouter)
- [@kontsedal/olas-eslint-plugin](#olaseslintplugin)
- [@kontsedal/olas-codemod](#olascodemod)

Each satellite package has its full reference in its own README. The sections for them below cover the main exports and link there.

---

<a id="olascore"></a>

# @kontsedal/olas-core

## Signals

The reactive substrate. A signal is a typed cell with a value. Reads inside `computed` or `effect` are auto-tracked, and writes notify subscribers. Wraps `@preact/signals-core`.

### `signal<T>(initial: T): Signal<T>`

Read-write signal. `.value` reads, `.set(v)` writes, `.update(fn)` writes a function of the current value. `.peek()` reads without registering a dependency. `.subscribe(fn)` calls `fn` at once with the current value and on every change, and returns an unsubscribe. `.subscribeChanges(fn)` skips that first call.

```ts
import { signal } from '@kontsedal/olas-core'

const count = signal(0)
console.log(count.value)         // 0
count.set(5)
count.update((n) => n + 1)       // 6
count.peek()                     // 6, no tracking
const unsub = count.subscribe((v) => console.log(v))
```

**See also:** SPEC §1, §20.1. [`.wiki/pitfalls/preact-signals-overload-return.md`](.wiki/pitfalls/preact-signals-overload-return.md) — type quirk if you import directly from `@preact/signals-core`.

### `computed<T>(fn: () => T): Computed<T>`

Derived read-only signal. Tracks every signal read inside `fn` and recomputes when any of them change. Glitch-free (a computed never reads a half-updated graph).

```ts
import { signal, computed } from '@kontsedal/olas-core'

const first = signal('Ada')
const last = signal('Lovelace')
const full = computed(() => `${first.value} ${last.value}`)
console.log(full.value)          // "Ada Lovelace"
```

**When not to use:** for *side effects* (writes, fetches, DOM). Use `effect` for those.

### `effect(fn: () => void | (() => void)): () => void`

Tracking side effect. Re-runs whenever its read signals change. `fn` may return a cleanup function that runs before the next invocation (and on disposal). The outer return value is an unsubscribe.

```ts
import { signal, effect } from '@kontsedal/olas-core'

const count = signal(0)
const stop = effect(() => {
  document.title = `Count: ${count.value}`
  return () => console.log('cleanup before next run')
})
count.set(1)                     // logs cleanup, retitles
stop()                           // tear down
```

**When to use this vs `ctx.effect(...)`:** inside a controller, use `ctx.effect(...)`, which ties the effect's lifetime to the controller's. Top-level `effect(...)` is for non-controller code and libraries.

### `batch(fn: () => void): void`

Group multiple writes so subscribers fire once. Inside `batch`, signal writes don't propagate until `fn` returns.

```ts
import { batch, signal } from '@kontsedal/olas-core'

const a = signal(1)
const b = signal(2)
batch(() => {
  a.set(10)
  b.set(20)
})                               // subscribers see (10, 20), not (10, 2) then (10, 20)
```

### `untracked<T>(fn: () => T): T`

Run `fn` without registering its signal reads as dependencies. Useful inside a `computed` and `effect` to "peek" at a value without re-running on its changes.

```ts
import { signal, computed, untracked } from '@kontsedal/olas-core'

const tracked = signal(1)
const peeked = signal(100)
const sum = computed(() => tracked.value + untracked(() => peeked.value))
// sum re-computes when `tracked` changes; not when `peeked` changes.
```

### Types: `Signal<T>`, `ReadSignal<T>`, `Computed<T>`

```ts nocheck
type ReadSignal<T> = {
  readonly value: T
  peek(): T
  subscribe(handler: (value: T) => void): () => void          // fires at once, then on every change
  subscribeChanges(handler: (value: T) => void): () => void   // fires on changes only
}

type Signal<T> = ReadSignal<T> & {
  value: T
  set(value: T): void
  update(fn: (prev: T) => T): void
}

type Computed<T> = ReadSignal<T>
```

`Signal<T>` is read-write; `ReadSignal<T>` is read-only. Functions that should accept both reads and writes use `Signal<T>`; functions that only observe use `ReadSignal<T>`. `Computed<T>` is a `ReadSignal<T>`.

---

## Time-based signals

Derived signals that delay or rate-limit a source.

### `debounced<T>(source, ms, options?): TimingSignal<T>`

`options?: TimingOptions`, which is `{ signal?: AbortSignal; leading?: boolean; trailing?: boolean }`. Reflects `source`, but waits `ms` after the last source change before emitting. Same value during the window; new value after. Great for "react after the user stops typing".

```ts
import { signal, debounced } from '@kontsedal/olas-core'

const term = signal('')
const dTerm = debounced(term, 300)
// dTerm.value lags term.value by up to 300ms after the last write.
```

`TimingSignal<T>` is `ReadSignal<T>` plus three methods and no `set()`. `cancel()` drops the pending emit. `flush()` emits the pending value now. `dispose()` tears down the internal effect and timer. Pass `options.signal` or call `dispose()` to release the `source` subscription; otherwise it lives for the process lifetime. `leading` defaults to `false` and `trailing` to `true`; `{ leading: false, trailing: false }` throws.

**See also:** `debouncedValidator(...)` for async validators specifically.

### `throttled<T>(source, ms, options?): TimingSignal<T>`

`options?: TimingOptions` (defaults `leading: true`, `trailing: true`). Reflects `source` at most once every `ms`. Drops intermediate values during the window. Returns the same `TimingSignal<T>` surface as `debounced` (see above).

```ts
import { signal, throttled } from '@kontsedal/olas-core'

const scrollY = signal(0)
const tScroll = throttled(scrollY, 50)
// tScroll.value updates at most every 50ms.
```

---

## Controllers & roots

### `defineController<Props, Api>(factory, options?): ControllerDef<Props, Api>`

```ts nocheck
function defineController<Props = void, Api = unknown>(
  factory: (ctx: Ctx, props: Props) => Api,
  options?: DefineControllerOptions,   // { name?: string }
): ControllerDef<Props, Api>
```

Declare a controller. The factory runs once per *instance*, one per `createRoot` or `ctx.child` call, and receives a fresh `ctx` bound to that instance's lifetime. The returned object is the controller's public API. `options.name` labels the controller in the devtools tree, in `controller:*` events and in error paths. Without it the runtime uses the factory's function name, else `"anonymous"`.

```ts file=counter.ts
import { defineController, signal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return {
    count,
    increment: () => count.update((n) => n + 1),
  }
})
```

**When not to use:** if a feature is only one derived signal and no lifecycle, a plain `computed` may be enough. Reach for `defineController` when you have async, mutations, fields, or multiple methods.

**See also:** SPEC §3, §20.2.

### `createRoot<Api, TDeps>(def, options): Root<Api>`

```ts nocheck
function createRoot<Api, TDeps extends Record<string, unknown> = AmbientDeps>(
  def: ControllerDef<void, Api>,
  options: RootOptions<TDeps>,
): Root<Api>
```

Instantiate a controller as a *root*. Roots have no props (`ControllerDef<void, Api>`), so all startup config goes in `deps`. The return value is a frozen handle. The controller's API is on `root.api`, beside the root's own controls: `dispose`, `suspend`, `resume`, `dehydrate`, `hydrate`, `waitForIdle`, `bindQuery`, `inject` and `debug`. A controller may return a member named `dispose` without taking the root's.

```ts
import { createRoot } from '@kontsedal/olas-core'
import { counter } from './counter'

const root = createRoot(counter, { deps: {} })
root.api.increment()
root.dispose()
```

A root whose controllers make a query, a mutation or a bound query needs a query engine: `createRoot(app, { deps, queries: queryEngine() })`. Without one, `createQuery`, `createMutation` and `bindQuery` throw a message that names the fix. A root built without an engine leaves the query engine out of the bundle.

**Multiple roots are fine.** Each is fully isolated, with its own query client and its own subscriptions. Useful in tests, in micro-frontends, or when one page hosts two independent features.

**See also:** SPEC §20.8, [`.wiki/decisions/root-handle-separate.md`](.wiki/decisions/root-handle-separate.md).

### Type: `RootOptions<TDeps>`

```ts nocheck
type RootOptions<TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  hydrate?: DehydratedState
  queries?: QueryEngine
  plugins?: readonly OlasPlugin[]
  scopes?: ReadonlyArray<readonly [Scope<unknown>, unknown]>
}
```

- `deps` — required object; available everywhere as `ctx.deps`. Use it for api clients, routers, services, the current time. `createRoot` infers the type from what you pass and does not check it against `AmbientDeps`, so a missing service compiles. Write `deps: { api } satisfies AmbientDeps` to have the compiler check it.
- `onError` — sink for *uncaught* errors from effects, mutations, caches, emitter handlers, plugins and construction. Throws inside `onError` are swallowed. Without it, errors go to `console.error`.
- `hydrate` — replay a `DehydratedState` produced on the server. It needs `queries`: without an engine, development builds warn and the payload is discarded.
- `queries` — the query engine, `queryEngine(options?)`. Root-wide query defaults are configured on it. Omit it for a root with no cache.
- `plugins` — `OlasPlugin`s, set up in order before the root factory runs and disposed in reverse. See [Plugins](#plugins).
- `scopes` — pre-seed scopes before the root factory runs. A binding here wins over a value a plugin provided, so a test can stand a fake in for a plugin's service.

### `queryEngine(options?): QueryEngine`

```ts nocheck
function queryEngine(options?: QueryEngineOptions): QueryEngine

type QueryEngineOptions = { defaults?: QueryDefaults }
```

The query engine: pass one to `createRoot` to give the root a cache. It is a definition, not an instance. Each root that adopts it builds its own client, so one engine value at module scope can serve several roots. One of them can be a `HydrationBoundary` that rebuilds its root under StrictMode.

```ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { counter } from './counter'

const queries = queryEngine({ defaults: { staleTime: 5 * 60_000, retry: 1 } })
const root = createRoot(counter, { deps: {}, queries })
```

The engine creates the root's client inside `createRoot`, before plugin setup and the controller factory, so a plugin's `setup` can already reach the cache.

### Type: `QueryDefaults`

```ts nocheck
type QueryDefaults = Pick<
  QuerySpec<never[], unknown>,
  | 'staleTime' | 'gcTime' | 'refetchOnWindowFocus' | 'refetchOnReconnect'
  | 'keepPreviousData' | 'retry' | 'retryDelay' | 'networkMode' | 'structuralShare'
>
```

Defaults for every query under a root, so app-wide policy is declared once instead of restated on all N `defineQuery` calls. Resolution is always **`spec.X ?? defaults.X ?? built-in`**, so an explicit per-query field always wins.

**When to use:** whenever your app's desired policy differs from the built-ins (`staleTime: 0`, `retry: 0`, `gcTime: 5min`). Without it, a single missed `staleTime` presents as "why does this refetch on every subscribe?" rather than as an error.

Applies to `defineQuery`, `defineInfiniteQuery` and `createCache`. `createCache` reads only `staleTime` and `keepPreviousData`, the two fields `LocalCacheOptions` shares. A focus or reconnect refetch of an infinite query re-fetches every loaded page.

**Not defaultable:** `refetchInterval`. A root-wide interval would start polling every query in the app, so opt in per query, in either of its two forms (see `QuerySpec` below). `id`, `key`, `fetcher` and `meta` are per-query identity and settings.

**See also:** SPEC §5.9. `createTestController` takes `queries: queryEngine({ defaults })`, so controllers whose behavior depends on the defaults are testable in isolation.

### Type: `Root<Api>`

```ts nocheck
type Root<Api> = {
  readonly api: Api
  bindQuery<Args extends unknown[], T>(query: Query<Args, T>, options?: BindQueryOptions): QueryActions<Args, T>
  bindQuery<Args extends unknown[], TPage, TItem>(
    query: InfiniteQuery<Args, TPage, TItem>,
    options?: BindQueryOptions,
  ): InfiniteQueryActions<Args, TPage, TItem>
  inject<T>(scope: Scope<T>): T
  dispose(): void
  suspend(options?: SuspendOptions): void     // SuspendOptions = { maxIdleTime?: number }
  resume(): void
  dehydrate(): DehydratedState
  hydrate(state: DehydratedState): void
  waitForIdle(): Promise<void>
  readonly debug: DebugBus
}
```

- `api` — what the root controller's factory returned.
- `bindQuery(query, options?)` — imperative operations on one query, bound to this root. See `bindQuery` under [Async data — queries](#async-data--queries).
- `inject(scope)` — resolve a scope as the root controller would: a value it provided, a `scopes` seed or a plugin's service, else the scope's default. Throws when none exists. App code outside every controller reaches a plugin's service this way, as in `root.inject(Entities)`.
- `dispose()` — recursively dispose every child, every primitive and every effect, then the plugins in reverse order, then the cache. Idempotent.
- `suspend()` and `resume()` — pause the tree without disposing it. Effects stop and subscriptions release their entries. With `maxIdleTime` (ms), the root disposes itself if it is not resumed in time.
- `dehydrate()` — serialize the cache into a `DehydratedState`. A root without an engine returns an empty state.
- `hydrate(state)` — apply dehydrated entries to the live cache. See [SSR](#ssr--dehydrate-and-hydrate).
- `waitForIdle()` — Promise that resolves when no fetch, no mutation and no work a plugin `track`ed is in flight. A `createCache` local cache is not a query-client entry, so its fetch is not counted; await `cache.firstValue()` for it.
- `debug` — devtools event bus; see [Devtools event bus](#devtools-event-bus).

### Type: `ControllerDef<Props, Api>`

Opaque handle returned by `defineController`. Pass to `createRoot(...)`, `ctx.child(...)`, `ctx.attach(...)` or `ctx.collection(...)`. Don't construct manually.

### Type: `AmbientDeps`

```ts
import type { ApiClient, Router } from './services'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: ApiClient
    router: Router
  }
}
```

App-wide module augmentation that names the keys and types in `ctx.deps`. After augmentation every `Ctx` exposes a typed `ctx.deps.api`, `ctx.deps.router` and so on, without per-controller generics. Without it, a `ctx.deps` value is `unknown`.

---

## The `Ctx` object

The factory-time API for one controller instance. Everything a controller creates, through a `ctx` method or a `create*(ctx, …)` function, is owned by that controller and disposed with it.

### `ctx.deps: TDeps`

Read-only reference to the root's `deps`. Augment the global `AmbientDeps` interface to type your services once across the app.

### `ctx.effect(fn: () => void | (() => void)): void`

Same semantics as the top-level `effect`, but the effect is disposed when the controller is. Use this inside a controller; never use top-level `effect` for controller-bound logic.

### `ctx.onDispose(fn: () => void): void`

Register a callback that runs when the controller is disposed. Use for one-off cleanup that isn't naturally an effect (e.g., disconnect a long-lived resource).

### `ctx.onSuspend(fn: () => void): void` / `ctx.onResume(fn: () => void): void`

Run when the controller is suspended and resumed. Suspension pauses subscriptions; resume restores them.

### `ctx.child<Props, Api>(def, props, options?): Api`

Construct a sub-controller. Returns the child's API directly. The child is disposed when *this* controller disposes. `options.deps` overrides some of the parent's `deps` for the child's sub-tree.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const cardEditor: ControllerDef<{ cardId: string }, { title: string }>
-->
```ts
import { defineController } from '@kontsedal/olas-core'

const board = defineController((ctx) => {
  const editor = ctx.child(cardEditor, { cardId: 'c1' })
  return { editor }
})
```

### `ctx.attach<Props, Api>(def, props, options?): { api; dispose; suspend; resume }`

Like `child(...)`, plus a handle that controls the sub-tree on its own. `dispose()` tears it down early, for example when the user closes a panel, and `suspend()` and `resume()` freeze and thaw it. All three are idempotent. The sub-tree is still disposed automatically if the parent disposes first. `<SuspendOnUnmount controller={handle}>` takes the handle as it is.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
type EditorApi = { title: string }
declare const cardEditor: ControllerDef<{ cardId: string }, EditorApi>
-->
```ts
import { defineController } from '@kontsedal/olas-core'

const board = defineController((ctx) => {
  let openEditor: { api: EditorApi; dispose: () => void } | null = null
  return {
    openCard: (cardId: string) => {
      openEditor?.dispose()
      openEditor = ctx.attach(cardEditor, { cardId })
    },
    closeCard: () => {
      openEditor?.dispose()
      openEditor = null
    },
  }
})
```

### `ctx.collection<Item, K, ...>(options): Collection<K, Api>`

Reconcile a reactive `source: ReadSignal<Item[]>` into a keyed set of child controllers: new keys construct a child, removed keys dispose theirs, unchanged keys are left alone (`propsOf` is **not** re-applied). Two forms. **Homogeneous** takes `{ source, keyOf, controller, propsOf }` and uses one def for every item. **Heterogeneous** takes `{ source, keyOf, factory }`, where `factory(item)` picks the controller and props per item and rebuilds on a type-discriminant change.

```ts nocheck
type Collection<K, Api> = {
  readonly items: ReadSignal<ReadonlyArray<{ readonly key: K; readonly api: Api }>>
  readonly size: ReadSignal<number>
  get(key: K): Api | undefined
  has(key: K): boolean
  suspendItem(key: K): void   // pause a row's effects without disposing it
  resumeItem(key: K): void
  isItemSuspended(key: K): boolean
}
```

A child factory that throws is routed to `root.onError` (`kind: 'construction'`) and skipped: the collection shows one fewer entry, and the diff loop doesn't re-throw. A whole-tree `suspend()` and `resume()` cascade, such as `SuspendOnUnmount`, does not auto-resume a `suspendItem`'d row. That suits virtualized lists. SPEC §11.1.

### `ctx.lazyChild<Props, Api>(loader, props, options?): LazyChild<Api>`

Code-split child controller. `loader: () => Promise<ControllerDef<Props, Api>>` is invoked on `load()` (idempotent); the child is constructed once the module resolves. SPEC §16.5.

```ts nocheck
type LazyChild<Api> = {
  readonly status: ReadSignal<'idle' | 'loading' | 'ready' | 'error'>
  readonly api: ReadSignal<Api | undefined>   // defined once status === 'ready'
  readonly error: ReadSignal<unknown | undefined>
  load(): Promise<Api>
  dispose(): void
}
```

### `ctx.debug(values: Record<string, unknown>): void`

Expose named values to the devtools "Variables" view for this controller. Pass live references: signals, computeds and fields render their current value and update in the panel. A later call merges into the earlier ones. A no-op in production builds.

```ts
import { computed, defineController, signal } from '@kontsedal/olas-core'

const counter = defineController((ctx) => {
  const count = signal(0)
  const doubled = computed(() => count.value * 2)
  ctx.debug({ count, doubled })
  return { count }
})
```

### `createField<T>(ctx, initial, options?): Field<T>`

See [Forms — Field](#forms--field).

### `createForm<S>(ctx, schema, options?): Form<S>`

See [Forms — Form](#forms--form).

### `createFieldArray<I>(ctx, itemFactory, options?): FieldArray<I>`

See [Forms — FieldArray](#forms--fieldarray).

### `createQuery(ctx, query, keyOrOptions?): AsyncState<T>` / `InfiniteQuerySubscription<...>`

See [Async data — queries](#async-data--queries).

### `bindQuery(ctx, query, options?): QueryActions<Args, T>`

See [Async data — queries](#async-data--queries).

### `createCache<T>(ctx, fetcher, options?): LocalCache<T>`

See [Async data — local cache](#async-data--local-cache).

### `createMutation<V, R>(ctx, specOrDef, hooks?): Mutation<V, R>`

See [Mutations](#mutations).

### `ctx.emitter<T>(): Emitter<T>` / `ctx.on(emitter, handler): void`

See [Emitters](#emitters).

### `ctx.provide<T>(scope, value): void` / `ctx.inject<T>(scope): T`

See [Scopes](#scopes).

---

## Async data — queries

Shared, keyed, cacheable async data. Two controllers subscribing to the same query with the same key share one fetch and one cache entry.

### `defineQuery<Args, T>(spec: QuerySpec<Args, T>): Query<Args, T>`

Declare a query at module scope. `id` is required. It is a stable, hand-written name, the same in the server and client bundles, and it names the query in SSR payloads, plugin events, devtools and error contexts. A derived name such as `fetcher.name` changes under minification. Subscribers pass the returned `Query` value to `createQuery(ctx, ...)`.

```ts file=queries.ts
import { defineQuery } from '@kontsedal/olas-core'

export type User = { id: string; name: string }

export const userQuery = defineQuery({
  id: 'users/detail',
  key: (id: string) => [id],
  fetcher: async ({ signal }, id) => {
    const res = await fetch(`/api/users/${id}`, { signal })
    if (!res.ok) throw new Error(res.statusText)
    return res.json() as Promise<User>
  },
  staleTime: 30_000,
})
```

The `Query` also exposes `invalidate`, `invalidateAll`, `setData`, `write`, `replace`, `peek`, `cancel`, `cancelAll` and `prefetch` at module level. They act on the one root that has used the query. Once two or more roots have used it, they throw or reject as ambiguous, and a bound handle from `bindQuery` picks the root.

**See also:** SPEC §5, [`.wiki/decisions/required-id-and-meta.md`](.wiki/decisions/required-id-and-meta.md).

### Type: `QuerySpec<Args, T>`

```ts nocheck
type QuerySpec<Args extends unknown[], T> = {
  id: string                  // required: stable, unique, hand-written
  key: (...args: Args) => unknown[]
  fetcher: (ctx: FetchCtx, ...args: Args) => Promise<T>
  staleTime?: number          // default 0: data is stale at once
  gcTime?: number             // default 5 * 60_000: drop the entry N ms after its last subscriber
  refetchInterval?: RefetchInterval<T>   // periodic background refetch while subscribed
  refetchOnWindowFocus?: boolean   // default false (the engine's defaults may override)
  refetchOnReconnect?: boolean     // default false (the engine's defaults may override)
  keepPreviousData?: boolean
  retry?: RetryPolicy         // default 0
  retryDelay?: RetryDelay     // default min(1000 * 2 ** attempt, 30_000) ms
  networkMode?: NetworkMode   // default 'online'
  structuralShare?: boolean   // default true
  meta?: QueryMeta            // per-query plugin settings
}

type FetchCtx = { signal: AbortSignal; deps: AmbientDeps }
type RefetchInterval<T> = number | ((data: T | undefined) => number)
type RetryPolicy = number | ((attempt: number, error: unknown) => boolean)
type RetryDelay = number | ((attempt: number) => number)
type NetworkMode = 'online' | 'always' | 'offlineFirst'
```

- **`key(...args)`** — must be a *pure* function of args. Its return value is stably hashed; same hash means same cache entry.
- **`fetcher(ctx, ...args)`** — receives the abort signal and the root deps as first arg, then the same positional args. Long-running fetchers must honor `signal`.
- **`networkMode`** — `'online'` defers a fetch while `navigator.onLine` is false and resumes on reconnect. `'always'` never gates on connectivity. `'offlineFirst'` starts the fetch anyway and parks it if it fails with a network error while offline.
- **`structuralShare`** — keeps unchanged sub-trees of a refetched value by reference. Turn it off for large payloads, where the deep walk on every poll costs more than a re-render.
- **`meta`** — settings the installed plugins read, such as `meta: { crossTab: true }`. See [Plugins](#plugins).
- **`refetchInterval`** — a fixed gap in ms, or a thunk resolved **once per tick** (for the *next* gap) against the entry's latest data:

  ```ts
  import { defineQuery } from '@kontsedal/olas-core'

  type Job = { id: string; state: 'queued' | 'running' | 'done' }

  export const jobsQuery = defineQuery({
    id: 'jobs/list',
    key: () => [],
    fetcher: ({ signal }) => fetch('/api/jobs', { signal }).then((r) => r.json() as Promise<Job[]>),
    // Poll fast while a job is running, back off when the queue is idle.
    refetchInterval: (jobs) => (jobs?.some((j) => j.state === 'running') ? 1_000 : 30_000),
  })
  ```

  The resolved gap must be a positive finite number, in **either** form. Anything else stops the timer for that entry and dev-warns, rather than spinning a hot loop. That covers `0`, `NaN`, a negative number and `Infinity`, as a literal or as a thunk's return. The timer restarts only on the entry's next 0→1 subscriber transition. A thunk must also not **throw**. A throw is caught and treated as a bad gap, with a dev warning carrying the error, because the resolution runs before the chain re-arms.

  The thunk's first call is synchronous at the 0→1 subscribe, before the initial fetch settles, so handle `data === undefined`. It is **not reactive**: a signal read inside yields that tick's value and registers no dependency. It is resolved **per entry, not per subscriber**, because the timer belongs to the shared cache entry. That is why `QuerySubscriptionOptions` has no `refetchInterval` and `QueryDefaults` excludes it. A `createCache` `LocalCache` has no interval at all. SPEC §5.9.

**Gotcha:** the value of `spec.key(...)` is what's hashed; the *original* `args` are what the fetcher receives. They're not the same thing — see [`.wiki/pitfalls/callargs-vs-keyargs.md`](.wiki/pitfalls/callargs-vs-keyargs.md).

### Type: `Query<Args, T>`

```ts nocheck
type Query<Args extends unknown[], T> = {
  invalidate(...args: Args): Promise<void>
  invalidateAll(): Promise<void>
  setData(...args: [...Args, updater: (prev: T | undefined) => T]): Snapshot
  write(...args: [...Args, updater: (prev: T | undefined) => T]): void
  replace(...args: [...Args, value: T]): void
  peek(...args: Args): T | undefined
  cancel(...args: Args): void
  cancelAll(): void
  prefetch(...args: Args): Promise<T>
}
```

- `invalidate(...args)` — mark a specific keyed entry stale and refetch it if it has subscribers. Awaitable: resolves when the refetch it triggered settles or is discarded. Ambiguity and disposed-root errors reject (spec §5.7).
- `invalidateAll()` — same, every entry of this query.
- `setData(...args, updater)` — **optimistic** patch of one key's cached data. Returns a `Snapshot` the caller must settle, normally by returning it from a mutation's `onMutate`, which finalizes on success and rolls back on error. Until it is settled the entry reports `hasPendingMutations: true` (spec §6.4).
- `write(...args, updater)` — **canonical** patch of one key's cached data: no snapshot, no rollback handle, `hasPendingMutations` untouched. This is the write for data that is already true (a server push folded into the cache, a realtime event, a cross-view sync). Reach for it whenever there is no mutation to settle a snapshot: a fire-and-forget `setData` leaks one live snapshot per call (spec §6.4). It leaves a fetch already in flight alone.
- `replace(...args, value)` — **canonical** replacement with a value that *is* the whole record, such as a server read-back. It supersedes a fetch already in flight for the key, because that request has nothing left to contribute. Like `write`, it pushes no snapshot.
- `peek(...args)` — read one key's cached data **synchronously**; `undefined` when there is nothing to read (no entry, or an entry that has not settled). Never creates an entry, never fetches, and registers **no reactive dependency**, so a `peek` inside a `computed` will not re-run it. For imperative moments: an event handler that needs the current value, or a guard before a `write` (spec §5.5).
- `cancel(...args)` — abort the in-flight fetch for one key (if any). Supersedes the request, restores a settled status, leaves `data` untouched. Call it before an optimistic `setData`, so a stale in-flight response can't clobber it. Do this **even when nothing invalidates the query**, because a stale entry refetches by itself whenever a subscription acquires or resumes (spec §5.5, §6.4).
- `cancelAll()` — cancel in-flight fetches for every keyed entry of this query.
- `prefetch(...args)` — fetch into the cache without subscribing (e.g., on hover before navigating).

### `bindQuery(ctx, query, options?)` and `root.bindQuery(query, options?)`

```ts nocheck
function bindQuery<Args extends unknown[], T>(
  ctx: Ctx,
  query: Query<Args, T>,
  options?: BindQueryOptions,        // { origin?: string }
): QueryActions<Args, T>             // the Query's methods, bound to one root
```

Bind a query to one root, for imperative reads and writes outside a subscription. The handle has the `Query`'s methods, and they target that root only. Binding neither subscribes nor fetches, so a bound `prefetch` works before any subscription exists. A bound operation fails after the root is disposed. An infinite query binds the same way, to `InfiniteQueryActions`.

`options.origin` stamps the handle's writes and invalidations with an origin for plugins. A realtime patcher tags its writes this way, and cross-tab then leaves them alone, because every tab receives the same server push itself.

```ts
import { bindQuery, defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

export const userMenu = defineController((ctx) => {
  const users = bindQuery(ctx, userQuery)
  return {
    prefetchUser: (id: string) => users.prefetch(id),
    refreshUser: (id: string) => users.invalidate(id),
  }
})
```

Outside a controller, `root.bindQuery(userQuery)` returns the same handle, for example to prefetch on the server before rendering.

### `createQuery<Args, T>(ctx, query, keyOrOptions?): AsyncState<T>`

Subscribe a controller to a `Query`. The `key` thunk reads signals: re-evaluating when they change re-keys the subscription, which releases the old entry and acquires the new one.

```ts
import { createQuery, defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

export const userProfile = defineController((ctx, props: { id: string }) => {
  const user = createQuery(ctx, userQuery, () => [props.id])
  return { user }
})
```

Forms accepted for the third argument:

- A thunk `() => Args` — reactive key.
- A `QuerySubscriptionOptions<Args>` object: `{ key?, enabled?, keepDataWhileDisabled? }`. `enabled` gates the subscription. While it returns false, the subscription holds no entry and fetches nothing, and it reports `isEnabled: false`, `status: 'idle'` and `undefined` for `data` and `error`. `refetch()` rejects with `QueryDisabledError`, and `firstValue()` waits until the subscription is enabled and loaded. Add `keepDataWhileDisabled: true` to keep reporting the last `data` across a disable, react-query's "a disabled observer still reads the cache" behaviour, for views that would otherwise flash empty. `error` is not retained.
- A `QuerySelectOptions<Args, T, U>` object: the same fields plus `select: (data: T) => U`. The subscription reports `select(data)`. The projection runs per subscriber, and the cache keeps the raw value.

**See also:** SPEC §5.2, §5.7, [`.wiki/decisions/disabled-subscriptions.md`](.wiki/decisions/disabled-subscriptions.md).

### Type: `AsyncState<T>` (`QuerySubscription<T>`)

```ts nocheck
type AsyncStatus = 'idle' | 'pending' | 'success' | 'error'

type AsyncState<T> = {
  data: ReadSignal<T | undefined>
  error: ReadSignal<unknown | undefined>
  status: ReadSignal<AsyncStatus>
  isLoading: ReadSignal<boolean>          // true only on initial load (no prior data)
  isFetching: ReadSignal<boolean>         // true on any in-flight fetch (incl. refetch)
  isStale: ReadSignal<boolean>
  lastUpdatedAt: ReadSignal<number | undefined>
  hasPendingMutations: ReadSignal<boolean>
  isPaused: ReadSignal<boolean>           // a fetch is parked waiting for network reconnect
  isEnabled: ReadSignal<boolean>          // false while the subscription's `enabled` returns false

  refetch: () => Promise<T>
  reset: () => void                       // clear error and status without re-fetching
  cancel: () => void                      // abort the in-flight fetch, keep data
  firstValue: () => Promise<T>            // resolves with the first success after subscribe
}
```

Subscribers can read any of the 10 signals individually, or use `useQuery(state)` in React to read them through one hook. A `createCache` `LocalCache` has the same surface, and its `isEnabled` stays `true`.

**`firstValue()`** resolves at once when data is already there, and rejects on the first failure. It is the promise to hand to Suspense or React 19's `use(...)`. A repeat call while it is pending returns the same promise.

**`isPaused`** is `true` while a fetch is deferred waiting for connectivity. Two cases reach it: an `online`-mode fetch that hit `navigator.onLine === false`, and an `offlineFirst` fetch that got a `fetch` `TypeError` while offline. It resumes automatically on the next `online` event. Nothing is in flight while paused (`isFetching` is `false`) and `status` stays `idle` or last-success rather than flipping to `error`.

### Types: `QuerySubscriptionOptions<Args>`, `QuerySelectOptions<Args, T, U>`

```ts nocheck
type QuerySubscriptionOptions<Args extends readonly unknown[]> = {
  key?: () => Args
  enabled?: () => boolean
  keepDataWhileDisabled?: boolean   // default false
}

type QuerySelectOptions<Args extends readonly unknown[], T, U> = QuerySubscriptionOptions<Args> & {
  select: (data: T) => U
}
```

### Class: `QueryDisabledError`

```ts nocheck
class QueryDisabledError extends Error {
  readonly queryId: string
}
```

What `refetch()` rejects with on a disabled subscription. A disabled subscription has no entry to fetch, and its key may not be computable yet. Filter the error, or disable the control while `subscription.isEnabled.value` is `false`.

---

## Async data — infinite queries

Cursor and page-based pagination accumulating into `pages: TPage[]`.

### `defineInfiniteQuery<Args, PageParam, TPage, TItem?>(spec): InfiniteQuery<Args, TPage, TItem>`

```ts file=feed.ts
import { defineInfiniteQuery } from '@kontsedal/olas-core'

export type Post = { id: string; title: string }
export type FeedPage = { items: Post[]; nextCursor: string | null }

export const feedQuery = defineInfiniteQuery({
  id: 'feed',
  key: (channel: string) => [channel],
  fetcher: async ({ pageParam, signal }, channel) => {
    const res = await fetch(`/api/feed/${channel}?cursor=${pageParam}`, { signal })
    return res.json() as Promise<FeedPage>
  },
  initialPageParam: '',
  getNextPageParam: (last: FeedPage) => last.nextCursor,
  itemsOf: (page: FeedPage) => page.items,
})
```

`id` is required, as on `defineQuery`, and unique across regular and infinite queries. `getPreviousPageParam` enables bidirectional lists. The spec also takes `staleTime`, `gcTime`, `refetchInterval`, `refetchOnWindowFocus`, `refetchOnReconnect`, `keepPreviousData`, `retry`, `retryDelay`, `networkMode`, `structuralShare` and `meta`, with the meanings they have on `QuerySpec`.

The subscription `createQuery(ctx, feedQuery, ...)` returns extends `AsyncState<TPage[]>`:

```ts nocheck
type InfiniteQuerySubscription<TPage, TItem> = AsyncState<TPage[]> & {
  pages: ReadSignal<TPage[]>
  flat: ReadSignal<TItem[]>          // the pages' items through `itemsOf`; equals `pages` without it
  hasNextPage: ReadSignal<boolean>
  hasPreviousPage: ReadSignal<boolean>
  isFetchingNextPage: ReadSignal<boolean>
  isFetchingPreviousPage: ReadSignal<boolean>
  fetchNextPage: () => Promise<void>
  fetchPreviousPage: () => Promise<void>
}
```

The `InfiniteQuery` handle has the `Query`'s module-level methods over the pages array: `invalidate`, `invalidateAll`, `setData`, `write`, `replace(...args, pages)`, `peek` (the loaded pages), `cancel`, `cancelAll` and `prefetch`. When an updater changes the page count, the entry trims `pageParams`, or pads them with the last param, to stay aligned.

Infinite queries have the integrations regular queries have. They dehydrate for SSR with their `pageParams` and refetch every loaded page on focus and reconnect. They park under `offlineFirst`, sync across tabs through `meta.crossTab`, and the entities plugin walks them. See [`.wiki/decisions/infinite-query-parity.md`](.wiki/decisions/infinite-query-parity.md).

`refetchInterval` works here too, with the same two forms: `RefetchInterval<TPage[]>`, so the thunk receives the entry's pages array (`undefined` until the first page lands). A tick re-fetches *every* loaded page (SPEC §5.11), so a list scrolled 20 pages deep costs 20 requests per tick. That is where a data-driven gap earns its keep.

---

## Async data — local cache

Controller-scoped cache — no sharing, dies with the controller.

### `createCache<T>(ctx, fetcher, options?): LocalCache<T>`

Use when one controller wants async data that no other controller will share. The cache disposes with the controller and never lives in the root's query client. It needs no query engine, and it still reads the engine's `staleTime` and `keepPreviousData` defaults when the root has one.

```ts
import { createCache, defineController } from '@kontsedal/olas-core'

type Summary = { posts: number; followers: number }

const profile = defineController((ctx, props: { id: string }) => {
  const summary = createCache(
    ctx,
    ({ signal }) =>
      fetch(`/api/users/${props.id}/summary`, { signal }).then((r) => r.json() as Promise<Summary>),
    { key: () => [props.id], staleTime: 60_000 },
  )
  return { summary }
})
```

**When to use this vs `defineQuery`:** if no other controller will need the same data, `createCache` is simpler — no module-scope query value, no `define` boilerplate. If sharing is *opportunistic* (might happen later), prefer `defineQuery` to avoid a refactor.

### Types: `LocalCache<T>`, `LocalCacheOptions<T>`

```ts nocheck
type LocalCache<T> = AsyncState<T> & {
  invalidate(): Promise<void>        // mark stale and refetch; resolves when the refetch settles
  setData(updater: (prev: T | undefined) => T): Snapshot
  dispose(): void
}

type LocalCacheOptions<T> = {
  key?: () => readonly unknown[]     // reactive: a change refetches
  staleTime?: number
  keepPreviousData?: boolean
  initialData?: T | undefined
}
```

---

## Mutations

Writes that may need optimistic updates, abort handling, and concurrency rules.

### `createMutation<V, R>(ctx, spec)` and `createMutation<V, R>(ctx, def, hooks?)`

```ts nocheck
function createMutation<V, R>(ctx: Ctx, spec: MutationSpec<V, R>): Mutation<V, R>
function createMutation<V, R>(ctx: Ctx, def: MutationDef<V, R>, hooks?: MutationHooks<V, R>): Mutation<V, R>
```

A write owned by this controller's lifetime. Pass an inline spec, or a module-scope `defineMutation(...)` value with this controller's lifecycle hooks layered on. A mutation needs a query engine on the root, because it counts toward the in-flight work `waitForIdle()` reads during SSR.

```ts
import { bindQuery, createMutation, defineController } from '@kontsedal/olas-core'
import { userQuery } from './queries'

const profile = defineController((ctx, props: { id: string }) => {
  const users = bindQuery(ctx, userQuery) // root-scoped cache operations
  const updateName = createMutation<string, void>(ctx, {
    id: 'users/rename',
    mutate: async (newName, { signal }) => {
      const res = await fetch(`/api/users/${props.id}`, {
        method: 'PATCH', body: JSON.stringify({ name: newName }), signal,
      })
      if (!res.ok) throw new Error('save failed')
    },
    onMutate: (newName) => {
      users.cancel(props.id) // a refetch in flight must not land over the optimistic value
      return users.setData(props.id, (prev) => {
        if (!prev) throw new Error('updateName before user loaded')
        return { ...prev, name: newName }
      })
    },
    onError: (_err, _vars, snapshot) => snapshot?.rollback(),
  })

  return { updateName }
})
```

### `defineMutation<V, R>(definition): MutationDef<V, R>`

Define a mutation at module scope. `id` is required. The definition holds the write and its policy (`mutate`, `concurrency`, `retry`, `retryDelay` and `meta`) and no lifecycle hooks. The hooks belong to the controller that runs it, through `createMutation(ctx, def, hooks)`.

`defineMutation` registers the definition by `id`, so a plugin can run it with no controller present. The mutation queue replays a persisted run this way. `mutate` must not close over controller state, because a replay has no controller. Reach services through `deps`.

```ts
import { createMutation, defineController, defineMutation } from '@kontsedal/olas-core'

type OrderInput = { idempotencyKey: string; items: string[] }

export const placeOrder = defineMutation({
  id: 'orders/place',
  mutate: async (vars: OrderInput, { signal }) => {
    const res = await fetch('/api/orders', { method: 'POST', body: JSON.stringify(vars), signal })
    if (!res.ok) throw new Error('order failed')
    return (await res.json()) as { orderId: string }
  },
})

const checkout = defineController((ctx) => {
  const place = createMutation(ctx, placeOrder, {
    onSuccess: (order) => console.log('placed', order.orderId),
  })
  return { place }
})
```

### Type: `MutationSpec<V, R>`

```ts nocheck
type MutationSpec<V, R> = {
  id?: string                          // devtools label, error contexts, plugin routing
  mutate: (vars: V, ctx: MutateCtx) => Promise<R>
  onMutate?: (vars: V) => Snapshot | void
  onSuccess?: (result: R, vars: V) => void
  onError?: (err: unknown, vars: V, snapshot: Snapshot | undefined) => void
  onSettled?: (result: R | undefined, err: unknown | undefined, vars: V) => void
  concurrency?: MutationConcurrency    // default 'parallel'
  retry?: RetryPolicy                  // default 0
  retryDelay?: RetryDelay              // default 1000 ms
  meta?: MutationMeta                  // per-mutation plugin settings
  detached?: boolean                   // default false — survive dispose
}

type MutateCtx = { signal: AbortSignal; deps: AmbientDeps }
type MutationConcurrency = 'parallel' | 'latest-wins' | 'serial'

type MutationDefinition<V, R> =   // what defineMutation takes
  Pick<MutationSpec<V, R>, 'mutate' | 'concurrency' | 'retry' | 'retryDelay' | 'meta'> & { id: string }
type MutationHooks<V, R> =        // what createMutation(ctx, def, hooks) adds
  Pick<MutationSpec<V, R>, 'onMutate' | 'onSuccess' | 'onError' | 'onSettled' | 'detached'>
```

- **`mutate(vars, { signal, deps })`** — the write. Honor `signal` so superseded and disposed runs can abort. `deps` is the owning controller's, or the root's on a plugin replay.
- **`onMutate(vars)`** — runs *before* `mutate`. Return a `Snapshot` from `query.setData(...)` to apply an optimistic update. The snapshot rolls back on its own when the run fails or is aborted, and `finalize()` commits it on success.
- **Concurrency modes:**
  - `parallel` *(default)* — runs are independent. `isPending` is true if any are in-flight.
  - `latest-wins` — a new `.run()` aborts the in-flight one.
  - `serial` — runs queue and execute one at a time.
- **`meta`** — settings the installed plugins read, such as `meta: { persist: true }` for the mutation queue. Nothing persists by default.
- **`detached`** — when `true`, `dispose()` stops cancelling: in-flight runs finish, queued `serial` runs drain, `run(...)` still works afterwards, and `onSuccess`, `onError` and `onSettled` still fire. Use it for **writes** whose completion the user has already been promised. Two examples: a licence activation behind a modal the user can close, and a destructive action whose confirm may be answered after its panel is gone. The callbacks then run after the controller is torn down, so keep them to client-level work such as `query.invalidate()` or a toast, and away from the controller's own signals and children. SPEC §6.5.

**Rollback is automatic.** A failed run rolls its snapshot back after `onError` returns, and an aborted run (latest-wins supersede, dispose) rolls back too. The snapshot is single-use, so an `onError` that calls `snapshot?.rollback()` itself makes the automatic call a no-op. A superseded `latest-wins` run is rolled back before the new run's `onMutate`, so the new optimistic write does not stack on the old one. See [`.wiki/pitfalls/latest-wins-rollback-order.md`](.wiki/pitfalls/latest-wins-rollback-order.md).

**A run that already finished is never rolled back.** If `mutate` resolves and the abort lands before the run's continuation, the snapshot is *finalized* rather than rolled back. The work happened, and rolling back would commit a knowingly stale value to a cache that outlives the mutation. The promise still rejects with `AbortError`. SPEC §6.2.

### Type: `Mutation<V, R>`

```ts nocheck
type Mutation<V, R> = {
  run: MutationRun<V, R>          // run(vars): Promise<R>; run() when V is void
  reset(): void                   // aborts in-flight runs, then clears back to 'idle'
  dispose(): void
  isPending: ReadSignal<boolean>
  status: ReadSignal<AsyncStatus>
  error: ReadSignal<unknown | undefined>
  lastVariables: ReadSignal<V | undefined>
  data: ReadSignal<R | undefined>
}
```

`status` is the latest run's outcome; React's `useMutation` derives `isIdle`, `isSuccess` and `isError` from it, so a `void` mutation still reports `isSuccess` after it resolves (it isn't stuck on `isIdle`). A superseded `latest-wins` run does not flip `status` to `'error'`: the run that superseded it owns the final status.

`reset()` **cancels**. It aborts every in-flight run, so awaiters reject with an `AbortError` that `isAbortError` matches, and it rejects queued `serial` runs so no caller hangs. It then clears `data`, `error` and `lastVariables`, and returns `status` to `'idle'` with `isPending` false. SPEC §6.2 lists it among the abort triggers.

**Gotcha when porting from react-query:** rq's `reset()` detaches the observer and lets the in-flight request finish. Olas aborts it. A mechanical `reset()` → `reset()` port silently changes whether the write lands.

### Class: `MutationDisposedError`

```ts nocheck
class MutationDisposedError extends Error {
  readonly mutationId: string | undefined   // the mutation's `id`, when it has one
  readonly controllerPath: readonly string[]
}
```

What `run(...)` rejects with once the mutation has been disposed. `mutate` is never called — **the write does not happen.**

It is deliberately **not** an `AbortError`. `isAbortError(err)` is how callers filter cancellations, and a run that was never accepted is not one. It is work the app asked for and silently did not get, and a blanket abort filter would hide the loss.

<!-- snippet-prelude
import type { Mutation } from '@kontsedal/olas-core'
declare const mutation: Mutation<{ title: string }, void>
declare const vars: { title: string }
declare const toast: { error(err: unknown): void }
-->
```ts
import { MutationDisposedError, isAbortError } from '@kontsedal/olas-core'

await mutation.run(vars).catch((e) => {
  if (e instanceof MutationDisposedError) {
    // the write never ran — own the mutation higher up, or mark it `detached`
  } else if (!isAbortError(e)) {
    toast.error(e)
  }
})
```

`detached: true` mutations never throw it: `run(...)` keeps working after dispose.

### Type: `Snapshot`

```ts nocheck
type Snapshot = {
  rollback: () => void
  finalize: () => void
}
```

Returned by `query.setData(...)` and `localCache.setData(...)`.

- `rollback()` — restore the previous data; also clears `hasPendingMutations` on the entry if no other snapshots are live.
- `finalize()` — commit the snapshot as the new truth. The mutation runner auto-calls this on success; user code rarely needs to.

Both are idempotent and mutually exclusive — whichever happens first wins, subsequent calls (including the runtime's auto-calls) no-op.

---

## Forms — `Field`

### `createField<T>(ctx, initial, options?): Field<T>`

```ts nocheck
function createField<T>(ctx: Ctx, initial: T, options?: FieldOptions<T>): Field<T>

type FieldOptions<T> = {
  validators?: ReadonlyArray<Validator<T>>
  validateOn?: 'change' | 'blur' | 'submit'   // default 'change'
}
```

Create a single field. The `initial` value seeds the field. `validators` run on every change, and on `revalidate()` and the owning form's `validate()`. `validateOn` sets when validation first runs: `'change'` at once, `'blur'` after the first `markTouched()`, `'submit'` after the first `revalidate()` or `Form.validate()`. Once it has run, every change re-validates.

```ts
import { createField, defineController, minLength, required } from '@kontsedal/olas-core'

const signup = defineController((ctx) => {
  const name = createField<string>(ctx, '', { validators: [required(), minLength(2)] })
  const nickname = createField<string>(ctx, '', { validateOn: 'blur' })
  return { name, nickname }
})
```

**Gotcha:** `createField` infers `T` from `initial`. With a `validators` array, `createField(ctx, '', { validators })` infers `Field<''>`, and `createField(ctx, null)` infers `Field<null>`. Annotate the type: `createField<string>(ctx, '', { validators })`. See [`.wiki/pitfalls/literal-type-narrowing.md`](.wiki/pitfalls/literal-type-narrowing.md).

### Type: `Field<T>`

```ts nocheck
type Field<T> = ReadSignal<T> & {
  readonly errors: ReadSignal<string[]>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>

  set(value: T): void
  setAsInitial(value: T): void
  reset(): void
  markTouched(): void
  revalidate(): Promise<boolean>
  setErrors(errors: ReadonlyArray<string>): void
  dispose(): void
}
```

- `set(value)` — write a new value; marks `isDirty: true` and triggers validators.
- `setAsInitial(value)` — write a new value AND re-anchor `reset()`'s target here, without marking dirty. Use for "load this value as the new baseline", most commonly when reseating a field from server data outside the `createForm(ctx, schema, { initial })` path.
- `setErrors(errors)` — pin errors from outside, typically a failed server-side validation. They live in their own channel, so a validator re-run does not clear them. The next `set(...)`, a `reset()` or `setErrors([])` does.
- `field.value` reads the current value directly, because `Field<T>` *is* a `ReadSignal<T>`. `Form` and `FieldArray` are `ReadSignal`s of their value too. See [`.wiki/decisions/forms-are-read-signals.md`](.wiki/decisions/forms-are-read-signals.md).

### Type: `Validator<T>`

```ts nocheck
type FormIssue = { path: (string | number)[]; message: string }
type ValidatorResult = string | null | FormIssue[]

type Validator<T> = (value: T, signal: AbortSignal) =>
  ValidatorResult | Promise<ValidatorResult>
```

Return `null` (or `[]`) for "valid", a non-empty string for "invalid (here's the error)". Sync validators return; async validators return a `Promise`. The `signal` aborts when the value changes mid-run.

Return a `FormIssue[]` to target **specific fields** from a form-level or array-level validator, such as a cross-field rule or a whole-form schema. Each issue's `path` routes its `message` onto the matching descendant field, form or array. An empty `path` means the node itself, so the message lands on `topLevelErrors`. On a leaf `Field`, `FormIssue[]` collapses to its messages (a leaf has no descendants). See `Form` below and SPEC §8.3.

### `debouncedValidator<T>(fn, ms): (value, signal) => Promise<string | null>`

`fn: (value: T, signal: AbortSignal) => Promise<string | null>`. The returned validator yields `string | null` (never `FormIssue[]`), so calling it directly and storing the result in a `string | null` signal type-checks; it's still assignable wherever a `Validator<T>` is expected.

Wrap an async validator so per-keystroke checks don't pile up. Cancels the prior run via `AbortSignal` when a new value arrives within `ms`.

```ts
import { debouncedValidator } from '@kontsedal/olas-core'

const usernameAvailable = debouncedValidator<string>(async (value, signal) => {
  const res = await fetch(`/api/check?name=${value}`, { signal })
  const taken = (await res.json()).taken as boolean
  return taken ? 'already taken' : null
}, 300)
```

---

## Forms — `Form`

### `createForm<S>(ctx, schema, options?): Form<S>`

Aggregate fields, sub-forms, and field-arrays into one typed object with `value`, `errors`, `isValid`, etc. The schema is a record of primitives.

```ts
import { createField, createForm, defineController, email, required } from '@kontsedal/olas-core'

const profile = defineController((ctx) => {
  const form = createForm(ctx, {
    name: createField<string>(ctx, '', { validators: [required()] }),
    email: createField<string>(ctx, '', { validators: [required(), email()] }),
    address: createForm(ctx, {
      street: createField<string>(ctx, ''),
      city: createField<string>(ctx, ''),
    }),
  })
  return { form }
})
```

Access nested fields via `form.fields.address.fields.city`. There is no path-typed `form.fieldAt('address.city')` — the nested shape covers ~95% of cases.

### Type: `Form<S>`

```ts nocheck
type Form<S extends FormSchema> = ReadSignal<FormValue<S>> & {
  readonly fields: { [K in keyof S]: S[K] }
  readonly errors: ReadSignal<FormErrors<S>>
  readonly topLevelErrors: ReadSignal<string[]>
  readonly flatErrors: ReadSignal<Array<{ path: string; errors: string[] }>>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly dirtyFields: ReadSignal<string[]>      // dotted paths of every dirty leaf
  readonly isSubmitting: ReadSignal<boolean>
  readonly submitCount: ReadSignal<number>
  readonly submitError: ReadSignal<unknown>

  set(partial: DeepPartial<FormValue<S>>): void
  setAsInitial(partial: DeepPartial<FormValue<S>>): void
  reset(): void
  clearSubtree(path: string): void
  markAllTouched(): void
  validate(): Promise<boolean>
  submit<R>(handler: (value: FormValue<S>) => R | Promise<R>, options?: SubmitOptions): Promise<SubmitResult<Awaited<R>>>
  setErrors(errors: Record<string, ReadonlyArray<string>>): void
  dispose(): void
}
```

- `form.value` is the aggregate `FormValue<S>`, because a `Form` is a `ReadSignal` of its value, like a `Field`. `form.subscribe` fires when any leaf changes.
- `set(partial)` deep-merges a partial value, batched; marks affected leaves dirty.
- `setAsInitial(partial)` loads `partial` as the form's new baseline. Every leaf it names takes the value as its initial, `isDirty` stays false, and a later `reset()` returns there. Use it for "load this from the server as the new baseline."
- `clearSubtree(path)` resets a named subtree to its initial, by dotted path. `''` resets the whole form.
- `validate()` runs every leaf's validators and resolves with `true` iff all leaves are valid.
- `setErrors({ 'address.city': ['Unknown city'] })` pins server errors on fields by dotted path, with numeric segments for array items. They clear on the field's next write.

### `form.submit(handler, options?): Promise<SubmitResult<R>>`

Run a submission. It validates first, then calls `handler(form.value)`, and it keeps `isSubmitting`, `submitCount` and `submitError` current. It resolves a discriminated union, so switch on `ok`, then on `reason`.

```ts nocheck
type SubmitResult<R> =
  | { readonly ok: true; readonly data: R }
  | { readonly ok: false; readonly reason: 'invalid' | 'busy' | 'disposed' }
  | { readonly ok: false; readonly reason: 'error'; readonly error: unknown }

type SubmitOptions = {
  validateBeforeSubmit?: boolean   // default true
  resetOnSuccess?: boolean         // default false
  onError?: 'rethrow' | 'capture'  // default 'capture'
}
```

- `'invalid'` — validation failed, and every leaf is marked touched.
- `'error'` — the handler threw, and `error` is the thrown value. With `onError: 'rethrow'` the promise rejects instead.
- `'busy'` — a submission was already in flight, so this one did not start.
- `'disposed'` — the form was disposed.

<!-- snippet-prelude
import type { Field, Form } from '@kontsedal/olas-core'
declare const form: Form<{ title: Field<string> }>
declare function save(value: { title: string }): Promise<{ id: string }>
-->
```ts
const result = await form.submit((value) => save(value))
if (result.ok) {
  console.log('saved', result.data.id)
} else if (result.reason === 'error') {
  console.error(result.error)
}
```

### Type: `FormOptions<S>`

```ts nocheck
type FormOptions<S> = {
  initial?: (() => DeepPartial<FormValue<S>> | undefined) | DeepPartial<FormValue<S>>
  validators?: FormValidator<S>[]
  resetOnInitialChange?: 'when-clean' | 'never' | 'always'   // default 'when-clean'
}
```

- `initial` — initial value object, or a thunk. If a thunk reads signals, the initial value re-applies when those signals change *and the form is not dirty*, so a background refetch cannot clobber a user mid-edit. Useful for "form-from-server" patterns (SPEC §8.4). `resetOnInitialChange` changes the rule: `'never'` runs the thunk once, and `'always'` re-seats a dirty form too.
- `validators` — top-level validators that see the whole `FormValue<S>`. A validator that returns a `string` lands in `topLevelErrors`; one that returns `FormIssue[]` routes each issue by `path` onto the matching field (empty path → `topLevelErrors`). Field-targeted messages merge into that field's `errors` and clear on the next form-level run.

---

## Forms — `FieldArray`

### `createFieldArray<I>(ctx, itemFactory, options?): FieldArray<I>`

Dynamic list of `Field<T>` or `Form<S>` items. The factory is invoked once per insertion, and it must build the item from its `initial` argument, or `add(x)` ignores `x` ([`.wiki/pitfalls/fieldarray-factory-uses-initial.md`](.wiki/pitfalls/fieldarray-factory-uses-initial.md)).

```ts
import { createField, createFieldArray, createRoot, defineController } from '@kontsedal/olas-core'

const todoList = defineController((ctx) => {
  const todos = createFieldArray(
    ctx,
    (initial?: string) => createField(ctx, initial ?? ''),
    { initial: ['buy milk', 'feed cat'] },
  )
  return { todos }
})

const { api } = createRoot(todoList, { deps: {} })
api.todos.add('walk dog')
api.todos.remove(0)
```

### Type: `FieldArray<I>`

```ts nocheck
type FieldArray<I extends Field<any> | Form<any>> = ReadSignal<FieldArrayValue<I>> & {
  readonly items: ReadSignal<ReadonlyArray<I>>
  readonly errors: ReadSignal<Array<FieldArrayItemErrors<I> | undefined>>
  readonly topLevelErrors: ReadSignal<string[]>
  readonly isValid: ReadSignal<boolean>
  readonly isDirty: ReadSignal<boolean>
  readonly touched: ReadSignal<boolean>
  readonly isValidating: ReadSignal<boolean>
  readonly size: ReadSignal<number>

  add(initial?: ItemInitial<I>): void
  insert(index: number, initial?: ItemInitial<I>): void
  remove(index: number): void
  move(from: number, to: number): void
  at(index: number): I | undefined
  clear(): void
  set(values: ReadonlyArray<ItemInitial<I>>): void
  setAsInitial(values: ReadonlyArray<ItemInitial<I>>): void
  reset(): void
  markAllTouched(): void
  validate(): Promise<boolean>
  dispose(): void
}
```

`array.value` is the items' values, `FieldArrayValue<I>`, and `items` holds the item nodes. `set(values)` writes through the items at overlapping indices, so their touched state and in-flight validators survive; extra values are appended and extra items removed. `setAsInitial(values)` rebuilds the items as the new baseline, with `isDirty` false. `FieldArrayOptions<I>` is `{ initial?, validators? }`.

---

## Forms — stdlib validators

Pre-built `Validator<T>` factories. Each accepts an optional custom message.

```ts
import { required, mustBeTrue, minLength, maxLength, min, max, email, pattern } from '@kontsedal/olas-core'

required('Name is required') // rejects '', null, undefined, []. A boolean `false` PASSES.
mustBeTrue('You must accept the terms') // rejects anything that isn't `true` — consent checkboxes
minLength(3, 'Min 3 characters')
maxLength(80)
min(18, 'Must be 18+')
max(120)
email('Invalid email')
pattern(/^\d{5}$/, 'ZIP must be 5 digits')
```

Each returns a `Validator<T>` you pass in `createField(ctx, initial, { validators: [validator, ...] })`. For complex or cross-field rules, write your own or use `@kontsedal/olas-zod`.

### `validator<I, O>(schema: StandardSchemaV1<I, O>): Validator<I>`

Wrap any Standard Schema v1 schema (Zod 4, Valibot 1, ArkType 2) as a validator. It returns every issue as a `FormIssue[]` carrying the schema's own `path`, so a whole-object schema works as a form-level validator that routes each issue onto its field. The `StandardSchemaV1` types are exported too.

---

## Scopes

Typed cross-tree data without prop drilling — like React context, but typed and tied to the controller tree.

### `defineScope<T>(options?): Scope<T>`

```ts file=scopes.ts
import { createEmitter, defineScope, type Emitter } from '@kontsedal/olas-core'

export const currentBoardScope = defineScope<{ id: string; title: string }>({ name: 'currentBoard' })
export const activityScope = defineScope<Emitter<string>>({ default: createEmitter<string>() })
```

Two `defineScope` calls — even with the same type — produce *distinct* scopes (identity is per-call). Use module-level singletons.

### `ctx.provide<T>(scope, value): void`

Provide a value for a scope on this controller. Descendant controllers, through `ctx.child`, `ctx.attach`, `ctx.collection` and `ctx.lazyChild`, read it via `ctx.inject`. A root is seeded from `RootOptions.scopes` and from the scopes its plugins `provide`.

### `ctx.inject<T>(scope): T`

Read the scope's value. Walks up the controller tree; throws if no provider and no default. The scope's default (passed to `defineScope`) is used when no ancestor provides one. Outside every controller, `root.inject(scope)` resolves the scope from the root.

```ts
import { defineController } from '@kontsedal/olas-core'
import { currentBoardScope } from './scopes'

const board = defineController((ctx, props: { boardId: string }) => {
  ctx.provide(currentBoardScope, { id: props.boardId, title: 'Roadmap' })
  return {}
})

const card = defineController((ctx) => {
  const current = ctx.inject(currentBoardScope)
  // current.id, current.title: typed.
  return { boardId: current.id }
})
```

**See also:** SPEC §10.3.

### Type: `Scope<T>` / `ScopeOptions<T>`

```ts nocheck
type ScopeOptions<T> = { default?: T; name?: string }   // `name` appears in error messages
type Scope<T> = { /* internal */ }
```

---

## Emitters

Typed pub/sub for cross-controller events. The emitter itself is a value, passed through `ctx.deps` or a scope.

### `createEmitter<T = void>(options?): Emitter<T>`

Standalone emitter. Use when you want one app-wide or share via a scope. `options.onError` receives a handler's throw; without it, the throw is logged. Either way the other handlers still run (SPEC §20.6).

```ts
import { createEmitter } from '@kontsedal/olas-core'

const activity = createEmitter<{ when: number; what: string }>()
activity.on((ev) => console.log(ev))
activity.emit({ when: Date.now(), what: 'card created' })
```

### `ctx.emitter<T = void>(): Emitter<T>`

Controller-scoped emitter. Disposes with the controller.

### `ctx.on<T>(emitter, handler): void`

Subscribe with handler cleanup tied to the controller's lifetime. Prefer this over `emitter.on(...)` inside a controller.

```ts
import { defineController } from '@kontsedal/olas-core'
import { activityScope } from './scopes'

const log = defineController((ctx) => {
  ctx.on(ctx.inject(activityScope), (ev) => console.log(ev))
  return {}
})
```

### Type: `Emitter<T>`

```ts nocheck
type Emitter<T> = {
  emit: [T] extends [void] ? () => void : (value: T) => void
  on(handler: (value: T) => void): () => void
  once(handler: (value: T) => void): () => void
  dispose(): void                  // later emit, on and once are no-ops
}
```

---

## Selection

### `createSelection<T = unknown>(options?): Selection<T>`

Multi-select state for tables and lists with bulk actions. It is a plain function, not bound to `ctx`: keep it in a controller's closure, and it dies with the closure. Ids are strings, and `options.initial` seeds the selected set. SPEC §16.5.

```ts
import { createSelection, defineController } from '@kontsedal/olas-core'

type Row = { id: string; name: string }

const table = defineController(() => {
  const selection = createSelection<Row>()
  return {
    selection,
    clickRow: (id: string, e: { shiftKey: boolean; metaKey: boolean }, ordered: readonly string[]) =>
      selection.handleClick(id, { shift: e.shiftKey, meta: e.metaKey }, ordered),
  }
})
```

```ts nocheck
type Selection<T = unknown> = {
  selectedIds: ReadSignal<ReadonlySet<string>>
  size: ReadSignal<number>
  isSelected(id: string): ReadSignal<boolean>
  select(id: string): void
  deselect(id: string): void
  toggle(id: string): void
  clear(): void
  selectAll(ids: readonly string[]): void
  handleClick(
    id: string,
    mods: { shift?: boolean; meta?: boolean },
    ordered: readonly string[] | ReadonlyMap<string, number>,
  ): void
}
```

`handleClick` has the standard click semantics. A plain click selects only `id`, a meta-click toggles it, and a shift-click selects the range from the anchor to `id` along `ordered`. `isSelected(id)` returns the same computed for an id while anything holds it, so a row can read it on every render without re-subscribing.

---

## Plugins

A plugin extends every root it is installed in. It observes cache writes and mutation runs, wraps fetches and `mutate` calls, and can expose a service to controllers. [`PLUGINS.md`](PLUGINS.md) is the authoring guide: the contract, the four shapes a plugin takes, a checklist and how to test one. This section lists the types. SPEC §13 is the contract, and [`.wiki/decisions/plugin-host-v2.md`](.wiki/decisions/plugin-host-v2.md) has the reasoning.

### `definePlugin(plugin: OlasPlugin): OlasPlugin`

An identity helper that types an object literal as an `OlasPlugin`. A plugin is a definition, not an instance: `setup` runs once for every root the plugin is installed in, and per-root state lives in its closure.

```ts
import { createRoot, definePlugin, queryEngine } from '@kontsedal/olas-core'
import { counter } from './counter'

export const logger = definePlugin({
  name: 'logger',
  setup(host) {
    return {
      onWrite: (e) => console.log(e.query.id, e.source, e.origin),
    }
  },
})

const root = createRoot(counter, { deps: {}, queries: queryEngine(), plugins: [logger] })
```

### Types: `OlasPlugin`, `PluginHost`

```ts nocheck
type OlasPlugin = {
  readonly name: string                          // unique per root; the origin of its writes
  setup(host: PluginHost): PluginHooks | void    // once per root, before the root factory runs
}

type PluginHost = {
  readonly deps: AmbientDeps
  provide<T>(scope: Scope<T>, value: T): void    // during setup only
  reportError(err: unknown): void                // → onError as { kind: 'plugin', pluginName }
  onDispose(fn: () => void): void
  track(work: Promise<unknown>): void            // root.waitForIdle() waits for it
  readonly network: NetworkHost                  // isOnline(), onReconnect(fn), onFocus(fn)
  readonly queries: QueryHost | null             // null without a query engine
  readonly mutations: MutationHost | null        // null without a query engine
  debug(payload: unknown): void                  // dev-only: the plugin's devtools lane
}

type QueryHost = {
  get(id: string): QueryRef | undefined          // QueryRef = { id, kind: 'query' | 'infinite', meta }
  keys(id: string): ReadonlyArray<readonly unknown[]>
  peek(id: string, key: readonly unknown[]): unknown
  write(id: string, key: readonly unknown[], updater: (prev: unknown) => unknown, options?: WriteOptions): void
  replace(id: string, key: readonly unknown[], value: unknown, options?: WriteOptions): void
  invalidate(id: string, key: readonly unknown[]): Promise<void>
  hydrate(state: DehydratedState): void
  dehydrate(): DehydratedState
  hashKey(key: readonly unknown[]): string
}

type MutationHost = {
  has(id: string): boolean
  get(id: string): MutationRef | undefined       // MutationRef = { id, meta }
  run(id: string, variables: unknown): Promise<unknown>
}
```

`host.queries` addresses the cache by query `id` and entry `key`, the output of the query's `key(...)`. `write` and `replace` are canonical and are no-ops for a key the root holds no entry for. `WriteOptions` carries an infinite query's `pageParams`. Every write a plugin makes through its host carries the plugin's `name` as its `origin`. `hashKey` is the stable hash the engine keys entries by.

`host.mutations` runs mutations registered with `defineMutation`, through the core runner. Their `retry` and `concurrency` apply, `mutate` receives the root's `deps`, and the run counts toward `waitForIdle()`. `get(id)` returns the definition's `id` and `meta`, so a plugin that replays stored runs checks that the definition opted in before it runs one.

### Type: `PluginHooks`

```ts nocheck
type PluginHooks = {
  onWrite?(event: WriteEvent): void
  onInvalidate?(event: InvalidateEvent): void    // { query, key, origin }
  onRemove?(event: RemoveEvent): void            // { query, key, reason: 'gc' }
  onActivate?(event: ActivityEvent): void        // an entry gained its first subscriber
  onDeactivate?(event: ActivityEvent): void      // an entry lost its last subscriber
  onMutation?(event: MutationEvent): void        // phase 'start', then 'success' | 'error' | 'cancel'
  wrapFetch?(context: FetchContext, next: () => Promise<unknown>): Promise<unknown>
  wrapMutate?(context: MutateContext, next: () => Promise<unknown>): Promise<unknown>
  dispose?(): void
}
```

Observation hooks are synchronous and run after subscribers see the change. Each is isolated: a throw goes to `onError` and the next plugin still runs. No hook runs once the root starts disposing. `wrapFetch` and `wrapMutate` compose in `plugins` order, the first outermost, around every attempt, retries included. `onMutation` fires for every run, with or without an `id`.

### Type: `WriteEvent`

```ts nocheck
type WriteEvent = {
  readonly query: QueryRef
  readonly key: readonly unknown[]
  readonly data: unknown                 // after the write; an infinite query's pages
  readonly updatedAt: number
  readonly source: WriteSource           // 'fetch' | 'hydrate' | 'optimistic' | 'rollback' | 'write' | 'replace'
  readonly origin: string | undefined    // a plugin name or bindQuery origin; undefined for the app and fetches
  readonly pageParams?: readonly unknown[]
}
```

`'optimistic'` and `'rollback'` are guesses the server has not confirmed, so a plugin that persists or relays state skips them. `packages/core/src/plugin/types.ts` has every field of `FetchContext`, `MutateContext` and `MutationEvent`.

### `QueryMeta` and `MutationMeta`

Per-query and per-mutation plugin settings, carried on `meta`. Both interfaces are empty in core. Each plugin package adds its fields through declaration merging, so `meta` accepts what the installed plugins understand. Core does not read it.

| Field | Added by | Effect |
|---|---|---|
| `QueryMeta.crossTab` | `@kontsedal/olas-cross-tab` | Mirror the query's writes across tabs. |
| `QueryMeta.persist` | `@kontsedal/olas-persist` | Keep the query in `persistQueryCachePlugin`'s storage. |
| `MutationMeta.persist` | `@kontsedal/olas-mutation-queue` | Persist each run and replay it after a reload. |

A plugin of your own types its settings the same way:

```ts
declare module '@kontsedal/olas-core' {
  interface QueryMeta {
    auditLog?: boolean
  }
}
```

---

## SSR — `dehydrate` and `hydrate`

### `root.dehydrate(): DehydratedState`

JSON-serializable snapshot of the root's query cache. Call on the server *after* `await root.waitForIdle()`. An infinite query serializes its pages with their `pageParams`, so the client keeps paging from where the server stopped.

### `root.waitForIdle(): Promise<void>`

Resolves when no query fetches, no mutations and no plugin-tracked work are in flight. Used on the server to wait for the data dependencies before serializing.

### `createRoot(def, { queries, hydrate })`

Replay a `DehydratedState` on the client. It needs a query engine. Hydrated entries don't refetch on first subscribe (within their `staleTime`).

### `root.hydrate(state: DehydratedState): void`

Apply dehydrated entries to a live root. An entry whose key is already bound is written through and supersedes a fetch in flight. The rest wait until a subscription binds their key. The React streaming intake uses it, and so does a warm start from storage. Idempotent.

### `serializeForScript(value: unknown): string`

Serialize a value as a JavaScript expression that is safe inside an inline `<script>`. The result is `JSON.parse("…")` over the JSON, with every character that could end the string, the script or an attribute written as a `\uXXXX` escape. That covers `<`, `>`, `&`, U+2028 and U+2029. A key named `__proto__` stays an own property. It throws what `JSON.stringify` throws, for a `BigInt` or a cycle. Query data is untrusted text, so inline every payload through it rather than through a bare `JSON.stringify` (SPEC §22).

```tsx
// server
import { createRoot, queryEngine, serializeForScript } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { renderToString } from 'react-dom/server'
import { App } from './App'
import { appController } from './app-controller'

export async function render(): Promise<string> {
  const root = createRoot(appController, { deps: {}, queries: queryEngine() })
  await root.waitForIdle()
  const html = renderToString(
    <OlasProvider root={root}>
      <App />
    </OlasProvider>,
  )
  const state = serializeForScript(root.dehydrate())
  root.dispose()
  return `<div id="app">${html}</div><script>window.__OLAS_STATE__ = ${state}</script>`
}
```

```tsx
// client
import { createRoot, type DehydratedState, queryEngine } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'
import { App } from './App'
import { appController } from './app-controller'

declare global {
  interface Window {
    __OLAS_STATE__?: DehydratedState
  }
}

const root = createRoot(appController, {
  deps: {},
  queries: queryEngine(),
  hydrate: window.__OLAS_STATE__,
})

const container = document.getElementById('app')
if (container !== null) {
  hydrateRoot(
    container,
    <OlasProvider root={root}>
      <App />
    </OlasProvider>,
  )
}
```

React apps can hand the client half to [`HydrationBoundary`](#olasreact), and stream the payload with `createStreamingHydrator`.

### Types: `DehydratedState`, `DehydratedEntry`

```ts nocheck
type DehydratedEntry = {
  id: string                        // the query's id
  key: readonly unknown[]
  data: unknown                     // an infinite query's pages
  lastUpdatedAt: number
  pageParams?: readonly unknown[]   // infinite queries only
}
type DehydratedState = { version: 1; entries: DehydratedEntry[] }
```

**See also:** SPEC §15, [`.wiki/flows/ssr.md`](.wiki/flows/ssr.md).

---

## Errors

### `RootOptions.onError`

```ts nocheck
type ErrorHandler = (err: unknown, context: ErrorContext) => void
```

Single sink for uncaught errors from effects, mutations, caches, emitter handlers, plugins and construction. Throws *inside* `onError` are swallowed.

```ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { counter } from './counter'

const root = createRoot(counter, {
  deps: {},
  queries: queryEngine(),
  onError: (err, context) => {
    const where = context.queryId ?? context.pluginName ?? context.controllerPath.join('/')
    console.error(`[${context.kind}] ${where}`, err, context.eventId)
  },
})
```

### Type: `ErrorContext`

```ts nocheck
type ErrorContext = {
  kind: 'effect' | 'cache' | 'mutation' | 'emitter' | 'construction' | 'plugin'
  controllerPath: readonly string[]   // root → leaf
  queryId?: string                    // cache kinds: the query's id
  key?: readonly unknown[]            // cache kinds: the entry's key
  eventId: string                     // unique per dispatch
  timestamp: number                   // wall-clock ms
  attempt?: number                    // 0-based retry attempt, for cache and mutation kinds
  cause?: unknown                     // the underlying error, when the surfaced one wraps it
  pluginName?: string                 // kind 'plugin' only
}
```

`eventId`, `timestamp`, `attempt` and `cause` are correlation fields for telemetry adapters, such as Sentry breadcrumbs or OpenTelemetry. SPEC §12, §20.9.

### `isAbortError(err): boolean`

Returns `true` for a `DOMException` named `AbortError`, and for any object whose `name` is `'AbortError'`, which covers axios, msw and hand-thrown errors. Use in `mutate` and `fetcher` catches when you want to distinguish user-aborts from real failures.

---

## Devtools event bus

### `root.debug: DebugBus`

```ts nocheck
type DebugBus = {
  subscribe(handler: (event: DebugEvent) => void): () => void
  queryEntries(): DebugCacheEntry[]
}
```

`subscribe` exposes a structured event stream: controller lifecycle, cache events, snapshot layers, mutation events, field validations and plugin lanes. It replays the live controller-tree snapshot synchronously to every new subscriber. `queryEntries()` returns a fresh "what's in the cache right now?" inspector snapshot. Used by `@kontsedal/olas-devtools`.

**Production behaviour.** In `@kontsedal/olas-core`'s production build, the bundler removes the emission sites. `subscribe` accepts a handler and returns a no-op unsubscribe, and no events fire. Use the devtools subscription in dev only; see SPEC §23.

### Type: `DebugEvent` (discriminated union)

Variants with the same fields are merged below for space. Each event also carries the `DebugEventMeta` correlation fields.

```ts nocheck
type DebugEventMeta = { seq?: number; t?: number; causeId?: string }

type DebugEventBody =
  | { type: 'controller:constructed'; path: readonly string[]; props: unknown; debug?: Record<string, unknown> }
  | { type: 'controller:suspended' | 'controller:resumed' | 'controller:disposed'; path: readonly string[] }
  | { type: 'controller:debug'; path: readonly string[]; values: Record<string, unknown> }
  | { type: 'cache:subscribed'; queryKey: readonly unknown[]; subscriberPath: readonly string[] }
  | { type: 'cache:fetch-start' | 'cache:invalidated' | 'cache:gc'; queryId?: string; queryKey: readonly unknown[] }
  | { type: 'cache:fetch-success'; queryId?: string; queryKey: readonly unknown[]; durationMs: number }
  | { type: 'cache:fetch-error'; queryId?: string; queryKey: readonly unknown[]; error: unknown; durationMs: number }
  | { type: 'cache:set-data'; queryId?: string; queryKey: readonly unknown[]; source: WriteSource; data: unknown }
  | { type: 'snapshot:push' | 'snapshot:rollback' | 'snapshot:finalize'; queryKey: readonly unknown[] }
  | { type: 'mutation:run'; path: readonly string[]; name?: string; vars: unknown }
  | { type: 'mutation:success'; path: readonly string[]; name?: string; result: unknown }
  | { type: 'mutation:error'; path: readonly string[]; name?: string; error: unknown }
  | { type: 'mutation:rollback'; path: readonly string[]; name?: string }
  | { type: 'field:validated'; path: readonly string[]; field: string; valid: boolean; errors: string[] }
  | { type: 'plugin:event'; plugin: string; payload: unknown }
```

`seq` is a per-root sequence number and the sort key for a timeline. `causeId` groups every event one cause produced, such as a mutation run with its optimistic write and rollback. Internal events may be added — the schema is stable enough to build tooling on, but not a public API guarantee. SPEC §14.

### Type: `DebugCacheEntry`

```ts nocheck
type DebugCacheEntry = {
  queryId: string
  key: readonly unknown[]
  status: 'idle' | 'pending' | 'success' | 'error'
  data: unknown
  error: unknown
  lastUpdatedAt: number | undefined
  isStale: boolean
  isFetching: boolean
  hasPendingMutations: boolean
}
```

Returned by `root.debug.queryEntries()` for the cache inspector. Two queries can hold entries under one key, so a view keys entries by `queryId` and `key` together. SPEC §20.9.

---

## Utilities

### `isAbortError(err: unknown): boolean`

See [Errors](#errors).

### `serializeForScript(value: unknown): string`

See [SSR](#ssr--dehydrate-and-hydrate).

### Re-exported types: `CtrlApi`, `CtrlProps`

Conveniences for extracting types from a `ControllerDef<Props, Api>`:

```ts
import type { CtrlApi, CtrlProps } from '@kontsedal/olas-core'
import type { counter } from './counter'

type Props = CtrlProps<typeof counter>   // void
type Api = CtrlApi<typeof counter>       // { count: Signal<number>; increment: () => void }
```

---

<a id="olascoretesting"></a>

# @kontsedal/olas-core/testing

Test-only helpers. Importing from a non-test file is a smell — the `/testing` sub-path makes it grep-able.

### `createTestController<Props, Api, TDeps>(def, options): Root<Api>`

```ts nocheck
function createTestController<Props, Api, TDeps extends Record<string, unknown>>(
  def: ControllerDef<Props, Api>,
  options: TestControllerOptions<Props, TDeps>,
): Root<Api>

type TestControllerOptions<Props, TDeps> = {
  deps: TDeps
  onError?: (err: unknown, context: ErrorContext) => void
  queries?: QueryEngine | null        // default: a live queryEngine(); null tests the no-engine path
  plugins?: readonly OlasPlugin[]
  scopes?: ReadonlyArray<readonly [Scope<unknown>, unknown]>
  hydrate?: DehydratedState
} & ([Props] extends [void] ? { props?: Props } : { props: Props })
```

Construct an isolated root around one controller. It returns the handle `createRoot` returns, so the controller's API is on `.api`. It differs from `createRoot` in two conveniences. The controller may take props, and `props` may be omitted when it takes none. The query engine defaults to a live one.

Each call builds its **own** root, and therefore its own cache, so two `createTestController` calls never share an entry. Test cache-lifetime behavior such as `gcTime` and dedup inside a single root, through `ctx.attach`.

```ts
import { createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { counter } from './counter'

test('counter increments', () => {
  const { api, dispose } = createTestController(counter, { deps: {} })
  api.increment()
  expect(api.count.peek()).toBe(1)
  dispose()
})
```

### `mockFetchPlugin(handlers?, options?): MockFetchPlugin`

Answer query fetches by query `id` without running their fetchers, as `wrapFetch` middleware. A handler is canned data, an error, or a function of the fetch attempt, each with optional latency. A query with no handler fails its fetch with an error that names it, so an unmocked request cannot reach the network. `{ passthrough: true }` lets it run its real fetcher instead.

```ts nocheck
type MockFetchHandler =
  | { data: unknown; delayMs?: number }
  | { error: unknown; delayMs?: number }
  | ((context: FetchContext) => unknown | Promise<unknown>)

type MockFetchOptions = { passthrough?: boolean; delayMs?: number }

type MockFetchPlugin = OlasPlugin & {
  readonly calls: readonly FetchContext[]                     // every attempt, retries included
  respond(queryId: string, handler: MockFetchHandler): void   // change an answer mid-test
}
```

```ts
import { createQuery, defineController } from '@kontsedal/olas-core'
import { createTestController, mockFetchPlugin } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { userQuery } from './queries'

const profile = defineController((ctx, props: { id: string }) => ({
  user: createQuery(ctx, userQuery, () => [props.id]),
}))

test('shows the mocked user', async () => {
  const mock = mockFetchPlugin({ 'users/detail': { data: { id: 'u1', name: 'Ada' } } })
  const { api, waitForIdle } = createTestController(profile, {
    deps: {},
    props: { id: 'u1' },
    plugins: [mock],
  })
  await waitForIdle()
  expect(api.user.data.peek()?.name).toBe('Ada')
  expect(mock.calls).toHaveLength(1)
})
```

### `createPluginRecorder(): PluginRecorder`

Record every plugin observation event a root emits, for assertions on `source`, `origin` and mutation phases. Install `recorder.plugin`, alone or beside the plugin under test. `events` holds everything in arrival order, tagged with its hook. `writes`, `invalidations`, `removals` and `mutations` hold one kind each, and `clear()` empties them all.

```ts
import { createMutation, defineController } from '@kontsedal/olas-core'
import { createPluginRecorder, createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'

const editor = defineController((ctx) => ({
  save: createMutation(ctx, { id: 'drafts/save', mutate: async (text: string) => text.length }),
}))

test('a save reports start then success', async () => {
  const rec = createPluginRecorder()
  const { api } = createTestController(editor, { deps: {}, plugins: [rec.plugin] })
  await api.save.run('hello')
  expect(rec.mutations.map((e) => e.phase)).toEqual(['start', 'success'])
})
```

[`PLUGINS.md`](PLUGINS.md) has a longer example that tests a plugin with both helpers.

### `fakeField<T>(initial, overrides?): Field<T>`

Shape-correct fake. Pass an initial value plus optional overrides for the read-only signals (`errors`, `isValid`, etc.) or methods (`set`, `revalidate`, etc.). Returns a real `Field<T>` — passes `useField(...)` and any component accepting a real field.

```tsx
import { fakeField } from '@kontsedal/olas-core/testing'
import { render } from '@testing-library/react'
import { NameInput } from './NameInput'

const name = fakeField<string>('Ada', { errors: ['too short'], touched: true })
render(<NameInput field={name} />)
```

### `fakeAsyncState<T>(overrides?): AsyncState<T>`

Same idea for `AsyncState<T>`. Pass overrides for any of the signal-backed fields, `isPaused` and `isEnabled` included, plus the `refetch`, `reset`, `cancel` and `firstValue` methods. Defaults: `status: 'idle'` unless `data` is provided (then `'success'`), and `isEnabled: true`.

```tsx
import { fakeAsyncState } from '@kontsedal/olas-core/testing'
import { render } from '@testing-library/react'
import { UserCard } from './UserCard'

const user = fakeAsyncState({ data: { id: '1', name: 'Ada' } })
render(<UserCard user={user} />)
```

---

<a id="olasreact"></a>

# @kontsedal/olas-react

The React adapter, built on `useSyncExternalStore` — concurrent-safe, no tearing, StrictMode-safe. The same package runs Preact apps through `preact/compat`; the [package README](packages/react/README.md) has the setup.

### `OlasProvider({ root, children })`

```ts nocheck
function OlasProvider(props: OlasProviderProps): ReactElement   // OlasProviderProps = { root: Root<unknown>; children: ReactNode }
```

Pass the root from your app entry. Components descended from this provider can call `useRoot()`. The provider only reads the root: the app creates it and owns its lifetime.

### `useRoot<Api = RegisteredApi>(): Api`

Resolve the provider's root api, `root.api`, in a component. Throws if called outside a provider, which surfaces the "I forgot to wrap" mistake at the first hook call.

Register the root's type once, where the app creates the root:

```ts file=root.ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { counter } from './counter'

export const root = createRoot(counter, { deps: {}, queries: queryEngine() })

declare module '@kontsedal/olas-react' {
  interface Register {
    root: typeof root
  }
}
```

Then `useRoot()` returns that root's api with no type argument:

```tsx
import { useRoot, useValue } from '@kontsedal/olas-react'

export function Counter() {
  const api = useRoot()
  return (
    <button type="button" onClick={api.increment}>
      {useValue(api.count)}
    </button>
  )
}
```

Without a registration, `useRoot()` returns `unknown`, and `useRoot<Api>()` names the type per call, as an unchecked cast. See [`.wiki/decisions/typed-use-root.md`](.wiki/decisions/typed-use-root.md).

### `createOlasContext<Api>(displayName?): OlasContext<Api>`

Mint an independent provider and a `useRoot` typed to one root, for two or more roots in one React tree. Each call returns a new React context. `OlasContext<Api>` is `{ Provider, useRoot, Context }`.

### `HydrationBoundary({ def, options, children, streaming? })`

Client-side SSR boundary: constructs a `Root<Api>` from a controller `def` and dehydrated state and provides it to descendants — the mirror of the server's `root.dehydrate()`.

`window.__OLAS_STATE__` is declared as in the [SSR](#ssr--dehydrate-and-hydrate) client example.

```tsx
import { queryEngine } from '@kontsedal/olas-core'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { App } from './App'
import { appController } from './app-controller'

const queries = queryEngine()

export const Main = () => (
  <HydrationBoundary
    def={appController}
    options={{ deps: {}, queries, hydrate: window.__OLAS_STATE__ }}
  >
    <App />
  </HydrationBoundary>
)
```

The boundary **owns** the root:

- Created lazily during the first render (in a ref, so `createRoot`'s side effects don't run twice under StrictMode) and **disposed on unmount**.
- `options` is read **once** on mount. A new inline `options={{...}}` on a parent re-render is ignored on purpose, so it won't discard cache state every render.
- The root is recreated only when the **`def` identity** changes (pass a different `def`, or re-key the component, to swap it on navigation). The replacement starts without `options.hydrate`, because the server payload described the first root's tree.
- `streaming` (default `true`) installs the streaming-SSR intake, so the `<script>` tags that `createStreamingHydrator().flush()` writes route into this root. Pass `false` for a one-shot `options.hydrate`.

### `useValue<T>(signal, options?): T`

```ts nocheck
function useValue<T>(signal: ReadSignal<T>, options?: UseValueOptions<T>): T
function useValue<T, U>(signal: ReadSignal<T>, options: UseValueSelectOptions<T, U>): U

type UseValueOptions<T> = { isEqual?: (a: T, b: T) => boolean }
type UseValueSelectOptions<T, U> = { select: (value: T) => U; isEqual?: (a: U, b: U) => boolean }
```

Subscribe a component to one signal: a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`. Returns the current value; re-renders on change. `select` projects the value, and `isEqual` (default `Object.is`) decides when a new value re-renders. Built on `useSyncExternalStore`.

```tsx
import type { ReadSignal } from '@kontsedal/olas-core'
import { useValue } from '@kontsedal/olas-react'

type User = { name: string; tags: string[] }

export function Greeting({ count, user }: { count: ReadSignal<number>; user: ReadSignal<User> }) {
  const n = useValue(count)
  const name = useValue(user, { select: (u) => u.name })
  return <span>{name}: {n}</span>
}
```

### `useQuery<T>(state, options?): UseQueryResult<T>`

```ts nocheck
function useQuery<T>(subscription: AsyncState<T>): UseQueryResult<T>
function useQuery<T>(subscription: AsyncState<T>, options: { suspense: true }): UseSuspenseQueryResult<T>

type UseQueryResult<T> = {
  data: T | undefined
  error: unknown | undefined
  status: AsyncStatus
  isLoading: boolean
  isFetching: boolean
  isStale: boolean
  isPaused: boolean
  isEnabled: boolean
  lastUpdatedAt: number | undefined
  hasPendingMutations: boolean
  refetch: () => Promise<T>
  reset: () => void
  cancel: () => void
}
```

Subscribe a component to an `AsyncState<T>`: a query subscription or a local cache. It returns every field of the state as a plain value, plus the actions.

**Fine-grained.** The component re-renders only when a field it read during render changes. `const { data } = useQuery(sub)` does not re-render when a background refetch flips `isFetching`. A field read later, in an event handler or an effect, returns its current value and is tracked from then on. Spreading the result reads, and so tracks, every field.

```tsx
import type { AsyncState } from '@kontsedal/olas-core'
import { useQuery } from '@kontsedal/olas-react'
import type { User } from './queries'

export function UserCard({ user }: { user: AsyncState<User> }) {
  const u = useQuery(user)
  if (u.isLoading) return <p>Loading…</p>
  if (u.error) return <p role="alert">Could not load the user.</p>
  return <h1>{u.data?.name}</h1>
}
```

**Suspense.** With `{ suspense: true }`, the hook throws `subscription.firstValue()` while there is no data, for the nearest `<Suspense>`. When the first load fails, it throws the error to the nearest error boundary. On success `data` is `T`. Refetches after a first success do not re-suspend, and a background-refetch failure that keeps the last data does not throw. A disabled query suspends until it is enabled and loads, which is what a dependent query wants. Development builds warn once when that starts.

### `useSuspenseQuery<T>(state): UseSuspenseQueryResult<T>`

Sugar over `useQuery(sub, { suspense: true })`, for call sites without an options bag. `data` is `T`.

### `useInfiniteQuery<TPage, TItem>(subscription, options?): UseInfiniteQueryResult<TPage, TItem>`

Subscribe a component to an infinite query subscription. The result has `useQuery`'s fields plus `pages`, `flat`, `hasNextPage`, `hasPreviousPage`, `isFetchingNextPage`, `isFetchingPreviousPage`, `fetchNextPage` and `fetchPreviousPage`. It is fine-grained the way `useQuery` is: a list that renders `flat` and `hasNextPage` does not re-render while `isFetchingPreviousPage` flips. `{ suspense: true }` suspends until the first page lands, with `useQuery`'s rules.

```tsx
import type { InfiniteQuerySubscription } from '@kontsedal/olas-core'
import { useInfiniteQuery } from '@kontsedal/olas-react'
import type { FeedPage, Post } from './feed'

export function Feed({ feed }: { feed: InfiniteQuerySubscription<FeedPage, Post> }) {
  const { flat, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(feed)
  return (
    <ul>
      {flat.map((post) => (
        <li key={post.id}>{post.title}</li>
      ))}
      {hasNextPage && (
        <button type="button" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
          More
        </button>
      )}
    </ul>
  )
}
```

### `useMutation<V, R>(mutation, callbacks?): UseMutationResult<V, R>`

```ts nocheck
type UseMutationResult<V, R> = {
  data: R | undefined
  error: unknown | undefined
  status: AsyncStatus
  isPending: boolean
  isIdle: boolean
  isSuccess: boolean
  isError: boolean
  lastVariables: V | undefined
  mutate: MutateFn<V>          // run's arguments, returns nothing
  run: MutationRun<V, R>       // returns the run's promise
  reset: () => void
}

type UseMutationCallbacks<V, R> = {
  onSuccess?: (data: R, variables: V) => void
  onError?: (error: unknown, variables: V) => void
  onSettled?: (data: R | undefined, error: unknown | undefined, variables: V) => void
}
```

Subscribe a component to a `Mutation<V, R>`, with two triggers:

- `mutate(vars)` is the call for an event handler. It returns nothing, and a failure lands on `error` and `status` and in `onError`, not as an unhandled rejection.
- `run(vars)` returns the run's promise, for a caller that needs the result. It rejects on failure, and the caller owns the rejection.

`isIdle`, `isSuccess` and `isError` derive from `status`, so a `void` mutation reports `isSuccess` after it resolves. The callbacks fire from the React layer, so put cache work in the mutation's own hooks. A run that was aborted fires none of them. Concurrency (`latest-wins`, `serial`, …) is configured on the mutation in the controller.

```tsx
import type { Mutation } from '@kontsedal/olas-core'
import { useMutation } from '@kontsedal/olas-react'

export function SaveButton({ save, draft }: { save: Mutation<string, void>; draft: string }) {
  const { mutate, isPending, isError } = useMutation(save)
  return (
    <button type="button" disabled={isPending} onClick={() => mutate(draft)}>
      {isError ? 'Retry' : 'Save'}
    </button>
  )
}
```

### `useField<T>(field: Field<T>): UseFieldResult<T>`

Subscribe to the field's value and its five state signals (`errors`, `isValid`, `isDirty`, `touched`, `isValidating`) with a single hook call. Returns the unwrapped values plus the action methods (`set`, `setAsInitial`, `reset`, `markTouched`, `revalidate` and `setErrors`), so binding to an `<input>` is one destructure. The actions keep their identity across renders.

```tsx
import type { Field } from '@kontsedal/olas-core'
import { useField } from '@kontsedal/olas-react'

export function NameInput({ field }: { field: Field<string> }) {
  const f = useField(field)
  return (
    <label>
      <span>Name</span>
      <input value={f.value} onChange={(e) => f.set(e.target.value)} onBlur={f.markTouched} />
      {f.touched && f.errors[0] && <em>{f.errors[0]}</em>}
    </label>
  )
}
```

### `useFieldInput<T>(field, options?): UseFieldInputResult`

Props ready to spread onto a native `<input>`, `<textarea>` or `<select>`: `value`, `onChange`, `onBlur`, `name` and `aria-invalid`. `onBlur` calls `markTouched()`, so `validateOn: 'blur'` works without extra wiring. `aria-invalid` is set once the field is touched and has errors. A field whose value is not a string needs a `transform`.

```tsx
import type { Field } from '@kontsedal/olas-core'
import { useFieldInput } from '@kontsedal/olas-react'

export function AgeInput({ age }: { age: Field<number> }) {
  return <input type="number" {...useFieldInput(age, { transform: { parse: Number, format: String } })} />
}
```

For the error message, render your own element and point the input at it with `aria-describedby`.

### `<SuspendOnUnmount controller>`

<!-- snippet-prelude
import type { SuspendableController } from '@kontsedal/olas-react'
import type { ReactNode } from 'react'
declare const panel: SuspendableController
declare const Panel: () => ReactNode
-->
```tsx
import { SuspendOnUnmount } from '@kontsedal/olas-react'

export const route = (
  <SuspendOnUnmount controller={panel}>
    <Panel />
  </SuspendOnUnmount>
)
```

Wrap a sub-tree so its unmount calls `controller.suspend()` and its remount calls `controller.resume()`, instead of disposing. The React tree still unmounts, so DOM, scroll and input state are not kept. Only the controller survives, with its effects paused. Useful for routes you switch back to often. Refcounted per controller, so two wrappers overlapping during a cross-fade keep it resumed until the last one unmounts. `controller` is any `SuspendableController`: a root, or the handle `ctx.attach` returns.

### `useSuspendOnHidden(controller: SuspendableController): void`

Suspends the controller when `document.visibilitychange` flips to hidden; resumes on visible, and on unmount if it is still the reason the controller is suspended. Pair with `<SuspendOnUnmount>` for tab-switching workloads.

### Type: `SuspendableController`

```ts nocheck
type SuspendableController = { suspend(): void; resume(): void }
```

Any object with `suspend` and `resume` satisfies this — a full `Root<Api>` or the handle `ctx.attach` returns.

### Streaming SSR: `createStreamingHydrator(options?)`

```ts nocheck
function createStreamingHydrator(options?: StreamingHydratorOptions): StreamingHydrator

type StreamingHydratorOptions = {
  nonce?: string              // CSP nonce for the emitted <script> tags
}

type StreamingHydrator = {
  plugin: OlasPlugin          // install on the root that renders
  flush(): string             // pending entries as one <script> tag, or ''
  dispose(): void             // drop captured state after the stream closes
}

function createStreamingTransform(flush: () => string): TransformStream<Uint8Array, Uint8Array>
function installStreamingIntake<Api>(root: Root<Api>): () => void
const OLAS_BOOTSTRAP_SCRIPT: string
const STREAMING_GLOBAL: '__OLAS_HYDRATION__'
```

The hydrator's plugin captures every committed write on the server root, meaning a fetch resolving or a canonical `write` or `replace`. `flush()` drains them as one `<script>` tag. On the client, a `HydrationBoundary` routes each streamed batch into its root through `root.hydrate`. An infinite query's entry carries its `pageParams`.

```tsx
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import {
  createStreamingHydrator,
  createStreamingTransform,
  OLAS_BOOTSTRAP_SCRIPT,
  OlasProvider,
} from '@kontsedal/olas-react'
import { renderToReadableStream } from 'react-dom/server'
import { App } from './App'
import { appController } from './app-controller'

export async function handle(nonce: string): Promise<Response> {
  const { plugin, flush } = createStreamingHydrator({ nonce })
  const root = createRoot(appController, { deps: {}, queries: queryEngine(), plugins: [plugin] })
  const stream = await renderToReadableStream(
    <OlasProvider root={root}>
      <App />
    </OlasProvider>,
    { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT, nonce },
  )
  return new Response(stream.pipeThrough(createStreamingTransform(flush)), {
    headers: { 'content-type': 'text/html' },
  })
}
```

- Install `plugin` on the root that renders. On a separate root it captures nothing.
- On the server, build one root per request and render it through `OlasProvider`. A `HydrationBoundary` builds its root during render and disposes it in an effect, and a server render runs no effects, so that root would never be disposed. Dispose the root, and call the hydrator's `dispose()`, once the response has finished.
- Pipe the render through `createStreamingTransform(flush)`. A stream chunk can end inside a tag or an attribute, so the transform writes a batch only where the HTML so far ends between elements. It drains once more when the stream closes. With Node's `renderToPipeableStream`, render with `renderToReadableStream` instead, or write `flush()` only after the stream has ended. See [`.wiki/pitfalls/stream-chunks-split-tags.md`](.wiki/pitfalls/stream-chunks-split-tags.md).
- `nonce` puts a Content-Security-Policy nonce on the emitted tags. Pass the same nonce to React for its own scripts.
- `OLAS_BOOTSTRAP_SCRIPT` primes the client's intake before hydration runs. Pass it as `bootstrapScriptContent`.
- The payload is serialized with `serializeForScript`, so query data cannot end the script or form markup.
- `installStreamingIntake(root)` connects a root to the stream by hand, for a custom provider shell, and returns the uninstall. `STREAMING_GLOBAL` names the global the intake lives under.

---

<a id="olasvue"></a>

# @kontsedal/olas-vue

The Vue 3 adapter. `olasPlugin(root)` provides a root to the app. Each composable turns signals into read-only refs, and the subscriptions end with the component's effect scope. Full surface: [package README](packages/vue/README.md).

```ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { olasPlugin } from '@kontsedal/olas-vue'
import { createApp } from 'vue'
import App from './App.vue'
import { counter } from './counter'

const root = createRoot(counter, { deps: {}, queries: queryEngine() })
createApp(App).use(olasPlugin(root)).mount('#app')
```

| Export | What it gives a component |
|---|---|
| `olasPlugin(root)` | A Vue plugin that provides the root: `createApp(App).use(olasPlugin(root))`. |
| `useRoot<Api = RegisteredApi>()` | `root.api`. Typed with no argument once the app augments `Register` in `@kontsedal/olas-vue`. Throws without a plugin. |
| `useValue(signal, options?)` | A `Readonly<Ref<T>>` over any `ReadSignal`. `options.isEqual` decides when Vue is triggered. |
| `useQuery(subscription)` | Each `AsyncState` field as a ref, plus `refetch`, `reset` and `cancel`. |
| `useInfiniteQuery(subscription)` | `useQuery`'s refs, plus `pages`, `flat`, the paging flags, `fetchNextPage` and `fetchPreviousPage`. |
| `useField(field)` | A writable `value` ref for `v-model`, the state as refs, and the field's actions. |
| `useMutation(mutation)` | The state as refs, plus `mutate` (fire-and-forget), `run` (returns the promise) and `reset`. |
| `Refs<T>` | The type of the state: each field of `T` as a read-only ref. |

---

<a id="olassvelte"></a>

# @kontsedal/olas-svelte

The Svelte adapter. Every `ReadSignal` already satisfies Svelte's store contract, so `$signal` works for a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray` with no wrapper. A `Field` has `set`, so `bind:value={$field}` writes through `field.set`. The package adds the root context and one store over each multi-signal object. Full surface: [package README](packages/svelte/README.md).

| Export | What it gives a component |
|---|---|
| `setRoot(root)` | Provides a root to the component tree below. Call it during component initialization. |
| `getRoot<Api = RegisteredApi>()` | `root.api` from the nearest `setRoot`. Typed with no argument once the app augments `Register` in `@kontsedal/olas-svelte`. |
| `queryStore(subscription)` | One store of the query's state (`$user.data`, `$user.isLoading`), plus `refetch`, `reset` and `cancel`. |
| `infiniteQueryStore(subscription)` | The same, plus `pages`, `flat`, the paging flags, `fetchNextPage` and `fetchPreviousPage`. |
| `fieldStore(field)` | One store of the field's value and validation state, plus its actions. |
| `mutationStore(mutation)` | One store of the mutation's state, plus `mutate`, `run` and `reset`. |

```svelte
<script>
  import { getRoot, queryStore } from '@kontsedal/olas-svelte'
  const user = queryStore(getRoot().user)
</script>

{#if $user.isLoading}Loading…{:else}{$user.data?.name}{/if}
```

---

<a id="olaspersist"></a>

# @kontsedal/olas-persist

Two ways to persist state: `createPersisted` mirrors one signal-shaped source to a storage adapter, and `persistQueryCachePlugin` keeps opted-in queries across reloads. Full surface: [package README](packages/persist/README.md).

### `createPersisted<T>(ctx, key, source, options?): Persisted`

Wire a signal-like source to persistent storage. Reads the saved value on construction (sync for localStorage, async if the adapter returns a promise). Subsequent source writes mirror to storage. Cleanup is bound to `ctx`.

```ts
import { defineController, signal } from '@kontsedal/olas-core'
import { createPersisted } from '@kontsedal/olas-persist'

const editor = defineController((ctx) => {
  const draft = signal('')
  const { ready } = createPersisted(ctx, 'my-app/draft', draft, { crossTab: true })
  return { draft, ready }
})
```

**Gotcha:** with localStorage, `createPersisted` reads the stored value during construction, so a returning visitor's first client render can disagree with the server HTML. See [`.wiki/pitfalls/persisted-state-breaks-hydration.md`](.wiki/pitfalls/persisted-state-breaks-hydration.md).

### Type: `PersistOptions<T>`

```ts nocheck
type PersistErrorOp = 'load' | 'deserialize' | 'serialize' | 'write' | 'migrate' | 'remoteChange'

type PersistOptions<T> = {
  storage?: StorageAdapter        // default: localStorageAdapter()
  serialize?: (value: T) => string
  deserialize?: (raw: string) => T
  crossTab?: boolean              // default: false — wire the adapter's onChange
  version?: number                // enable the {v,d} envelope + forward migration
  migrate?: (raw: string, fromVersion: number | undefined) => T | undefined | Promise<T | undefined>
  throttleMs?: number             // at most one write per window (flushed on dispose). Default 0
  onError?: (err: unknown, op: PersistErrorOp, key: string) => void // else swallowed
}
```

`version` and `migrate` wrap writes in a `{"v":N,"d":<serialized>}` envelope and forward-migrate a stale or legacy payload on load. Every fallible op routes through `onError`: storage `get` and `set`, encode and decode, migrate throws, and cross-tab corruption. Without it, errors are swallowed. A user write that lands before an async load settles wins over the stored value (and is flushed); a racing cross-tab change is buffered until ready.

### Type: `PersistableSource<T>`

```ts nocheck
type PersistableSource<T> = {
  readonly value: T
  set(value: T): void
  subscribe(handler: (value: T) => void): () => void
}
```

Structural — anything matching this shape works (a `Signal<T>`, a `Field<T>`, your own object).

### Type: `Persisted`

```ts nocheck
type Persisted = { ready: ReadSignal<boolean> }
```

`ready` flips to `true` once the initial load completes. Synchronous for localStorage; useful for async storage adapters.

### Type: `StorageAdapter`

```ts nocheck
type StorageAdapter = {
  get(key: string): string | null | Promise<string | null>
  set(key: string, value: string): void | Promise<void>
  delete(key: string): void | Promise<void>
  // optional change notifications (localStorage 'storage' event; IDB via BroadcastChannel)
  onChange?(handler: (key: string, value: string | null) => void): () => void
  // optional key enumeration (mutation-queue replay, clearPersisted)
  keys?(): Iterable<string> | Promise<Iterable<string>>
}
```

### `localStorageAdapter(): StorageAdapter`

The default adapter, as a factory. `get` returns `null` if `localStorage` is undefined, so it is SSR-safe. `get`, `set`, `delete` and `keys` are synchronous. `onChange` listens to the `storage` event, which fires for writes in other tabs.

### `indexedDbAdapter(options?): StorageAdapter`

Async IndexedDB-backed adapter (single key/value object store). `options?: IndexedDbAdapterOptions`, which is `{ databaseName?, storeName?, channelName?, indexedDB?, broadcastChannel? }`; `channelName: null` turns cross-tab notifications off. IDB has no native change event, so `onChange` is layered via `BroadcastChannel`. Writes resolve on the transaction's **commit** (not the request's `onsuccess`), so quota or commit failures reject and reach `onError('write')`. SSR-safe (no `IDBFactory` → every op no-ops). Pick it over `localStorage` for larger payloads or where async storage is acceptable.

### `clearPersisted(storage?, options?): Promise<void>`

```ts nocheck
function clearPersisted(storage?: StorageAdapter, options?: ClearPersistedOptions): Promise<void>

type ClearPersistedOptions = {
  prefix?: string                                // delete only keys starting with this
  all?: boolean                                  // required when there is no prefix
  onError?: (err: unknown, key: string) => void  // a failed enumeration reports the key '<keys>'
}
```

Clear persisted keys, for a log-out flow. The scope must be explicit: pass a non-empty `prefix`, or `all: true` to accept that every key the adapter enumerates goes. With neither, it throws, because the default adapter is `localStorage`, which the whole origin shares. An adapter without `keys()` reports `'<keys>'` through `onError` and deletes nothing.

```ts
import { clearPersisted, localStorageAdapter } from '@kontsedal/olas-persist'

await clearPersisted(localStorageAdapter(), { prefix: 'my-app/' })
```

### `persistQueryCachePlugin(options?): OlasPlugin`

Persist the query cache across reloads. A query opts in with `meta: { persist: true }`. The plugin writes every canonical write of an opted-in query to storage, throttled: a fetch, a `write`, a `replace` or a hydration. It restores the stored cache when the root starts. Optimistic writes and rollbacks are not persisted, and an entry the cache garbage-collects leaves storage too.

```ts
import { createRoot, defineQuery, queryEngine } from '@kontsedal/olas-core'
import { persistQueryCachePlugin } from '@kontsedal/olas-persist'
import { counter } from './counter'

type Settings = { theme: 'light' | 'dark' }

export const settingsQuery = defineQuery({
  id: 'settings/current',
  key: () => [],
  fetcher: ({ signal }) => fetch('/api/settings', { signal }).then((r) => r.json() as Promise<Settings>),
  meta: { persist: true },
})

const root = createRoot(counter, {
  deps: {},
  queries: queryEngine(),
  plugins: [persistQueryCachePlugin({ key: 'my-app/query-cache', buster: 'v1' })],
})
```

```ts nocheck
type PersistQueryCacheOptions = {
  storage?: StorageAdapter                  // default localStorageAdapter()
  key?: string                              // default 'olas/query-cache'
  buster?: string                           // a cache stored under another buster is discarded; default ''
  maxAgeMs?: number                         // older entries are not restored; default 24 hours
  throttleMs?: number                       // default 1000
  include?: (query: QueryRef) => boolean    // default: meta.persist === true
  restore?: boolean                         // default true
  onError?: (error: unknown, op: 'restore' | 'write') => void
}
```

With synchronous storage, the restore happens during setup, before any controller subscribes. With asynchronous storage such as IndexedDB, the restore lands later and fills only entries nothing has subscribed to, and `root.waitForIdle()` waits for it. When the first render must see the restored data, await `restoreQueryCache(options)` before `createRoot`. Pass its result as `hydrate`, and give the plugin `restore: false`.

---

<a id="olaszod"></a>

# @kontsedal/olas-zod

Bridge Zod schemas into Olas validators and forms.

### `zodValidator<T>(schema: z.ZodType<T>): Validator<T>`

Wrap a Zod schema as a synchronous `Validator<T>` (a thin alias over `validator(...)` from `@kontsedal/olas-core`, since Zod 4 implements Standard Schema). It returns `FormIssue[]` carrying each issue's `path`, so it works in both positions. As a leaf **field** validator, leaf issues have empty paths and collapse to messages. Given a whole-object schema, it works as a **form-level** validator that routes each issue onto the matching field.

```ts
import { createField, defineController } from '@kontsedal/olas-core'
import { zodValidator } from '@kontsedal/olas-zod'
import { z } from 'zod'

const contact = defineController((ctx) => {
  const email = createField<string>(ctx, '', { validators: [zodValidator(z.string().email())] })
  return { email }
})
```

### `zodValidatorAsync<T>(schema: z.ZodType<T>): Validator<T>`

Same, for schemas with async `.refine(...)` or `.transform(...)` checks. It resolves with the first issue's message or `null`, and it throws an `AbortError` when the validation's signal fires.

### `createZodForm<T>(ctx, schema, options?): Form<...>`

Walk a `z.object(...)`, `z.array(...)` and leaf tree and emit the matching `Form`, `FieldArray` and `Field` structure with validators auto-attached. The return type is structurally precise, so `form.fields.name.value` is a `string`. Each leaf starts at its Zod default, else an empty value for its type.

```ts
import { defineController } from '@kontsedal/olas-core'
import { createZodForm } from '@kontsedal/olas-zod'
import { z } from 'zod'

const Schema = z.object({
  name: z.string().min(2),
  age: z.number().min(0),
  tags: z.array(z.string()),
})

const signup = defineController((ctx) => {
  const form = createZodForm(ctx, Schema, { initial: { name: 'Ada' } })
  // form.value: { name: string; age: number; tags: string[] }
  return { form }
})
```

`ZodFormOptions<T>` is `{ initial?, resetOnInitialChange?, extraValidators? }`. `initial` is a partial value or a tracked function, which re-seats the form when the signals it reads change, as `createForm`'s does. `extraValidators` adds validators per leaf, keyed by the leaf's dotted path in the schema (`'address.street'`).

**Rules on objects and arrays are enforced.** A leaf's own rules run on its field. A rule on an object or an array lands on the node its path names:

- a root `.refine(fn)` with no `path` lands in `form.topLevelErrors`;
- a `.refine(fn, { path: ['confirm'] })` lands in `form.fields.confirm.errors`;
- an array-level rule, `z.array(...).min(3)` or a `.refine` on the array, lands in that `FieldArray`'s `topLevelErrors`;
- a `.refine` on a nested object lands in that nested form's `topLevelErrors`.

```ts
import { defineController } from '@kontsedal/olas-core'
import { createZodForm } from '@kontsedal/olas-zod'
import { z } from 'zod'

const Order = z
  .object({
    lines: z.array(z.object({ sku: z.string().min(1) })).min(1, 'Add a line'),
    total: z.number(),
  })
  .refine((v) => v.total > 0, { path: ['total'], message: 'Total must be positive' })

const checkout = defineController((ctx) => {
  const form = createZodForm(ctx, Order)
  form.fields.lines.topLevelErrors.value // ['Add a line']
  form.fields.total.errors.value // ['Total must be positive']
  return { form }
})
```

A message the leaf's own rule already reports is not repeated. An unresolvable path lands in `form.topLevelErrors`, and an async rule is awaited. The rules need a parse of the whole schema on every change to the form, so `createZodForm` installs that parse only when an object or an array in the schema carries a rule. A schema with rules on its leaves alone pays for those leaves only.

`rootOnlyZodValidator(schema)` reports only a schema's first issue with an empty path, and drops every issue with a path. It suits a hand-built `createForm` whose leaves validate themselves. `createZodForm` does not use it.

### Types: `ZodToLeaf<S>`, `UnwrapZod<S>`

`ZodToLeaf<S>` is the mapped type for the Olas-form structure derived from a Zod schema. Useful for typing form-walking helpers. `UnwrapZod<S>` strips a schema's `.default()`, `.optional()` and `.nullable()` wrappers.

---

<a id="olasdevtools"></a>

# @kontsedal/olas-devtools

In-app debugging UI consuming `root.debug`. Two main components, both React. Full surface: [package README](packages/devtools/README.md).

### `<DevtoolsLauncher root defaultTab? maxEntries? maxTimelineEntries? storageKey? urlHashKey? initial? />`

Floating, draggable, resizable host for the panel. Renders a small launcher button (always present) and, when open, a `position: fixed` window with the panel inside. Position, size, open and minimized state persist to `localStorage` under `storageKey`.

```tsx
import type { Root } from '@kontsedal/olas-core'
import { DevtoolsLauncher } from '@kontsedal/olas-devtools'
import { OlasProvider } from '@kontsedal/olas-react'
import { App } from './App'

export function Shell({ root }: { root: Root<unknown> }) {
  return (
    <OlasProvider root={root}>
      <App />
      {import.meta.env.DEV && <DevtoolsLauncher root={root} />}
    </OlasProvider>
  )
}
```

### `<DevtoolsPanel root defaultTab? maxEntries? maxTimelineEntries? urlHashKey? />`

The panel itself — for embedding inside your own chrome (e.g., a fixed sidebar). The launcher uses this internally. The timeline keeps the newest events in a ring buffer, 10,000 by default (`maxTimelineEntries`), and counts what it overwrote. `/` focuses the omnibox, which searches controllers, cache entries, mutations, fields and events. A plugin's `host.debug` payloads show in the timeline as that plugin's lane. `urlHashKey` keeps the tab and filters in the URL hash.

### Type: `DevtoolsTab`

```ts nocheck
type DevtoolsTab = 'timeline' | 'tree' | 'cache' | 'inspector' | 'mutations' | 'fields'
```

### Formatters and the store

`formatPath(path: string[]): string`, `formatPayload(value: unknown): string`, `formatTime(ms: number): string` — utilities the panel uses, exported for embedding in custom views. `DevtoolsStore` is the event store behind the panel, for a custom view over the same data.

---

<a id="olascrosstab"></a>

# @kontsedal/olas-cross-tab

`BroadcastChannel`-backed cross-tab cache sync, as a plugin. Queries that opt in with `meta: { crossTab: true }` mirror their writes and invalidations to other tabs of the same origin. Full surface: [package README](packages/cross-tab/README.md).

```ts
import { createRoot, defineQuery, queryEngine } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { counter } from './counter'

type Cart = { items: string[] }

export const cartQuery = defineQuery({
  id: 'cart/current',
  key: () => [],
  fetcher: ({ signal }) => fetch('/api/cart', { signal }).then((r) => r.json() as Promise<Cart>),
  meta: { crossTab: true },
})

const root = createRoot(counter, {
  deps: {},
  queries: queryEngine(),
  plugins: [
    crossTabPlugin({
      channelName: 'my-app/cache/v1',
      validate: (queryId, data) =>
        queryId !== 'cart/current' || (typeof data === 'object' && data !== null && 'items' in data),
    }),
  ],
})
```

```ts nocheck
type CrossTabOptions = {
  channelName: string                                    // include a version suffix: 'my-app/cache/v1'
  optimistic?: boolean                                   // also mirror setData and its rollback; default true
  origins?: readonly string[]                            // plugin origins whose writes cross too
  validate?: (queryId: string, data: unknown) => boolean // check a peer's payload before writing it
  maxPayloadBytes?: number                               // soft cap that warns; default 512 KB
  onWarn?: (message: string, cause?: unknown) => void    // default console.warn
  channelFactory?: (name: string) => ChannelLike | undefined
}
```

- Only queries with `meta: { crossTab: true }` sync, on both the send and the receive side. That includes infinite queries, whose pages travel with their `pageParams`.
- The plugin mirrors the app's own writes and invalidations. A write another plugin made is usually derived, and every tab makes it itself, such as a realtime push. `origins` lists the plugin names whose writes cross too. A direct `entities.update(...)` happens in one tab, so list `ENTITIES_PLUGIN_NAME` there when the other tabs should see it.
- In a development build, each message the plugin posts and each one a peer sent reach its devtools lane, with the peer's `sourceId`, the message type and what became of it.
- Fetches and hydration stay in their tab, because every tab runs its own fetcher.
- `validate(queryId, data)` guards the receive side: any same-origin script can post on the channel. A `false` drops the message and reports it through `onWarn`.
- Without `BroadcastChannel` and without a `channelFactory`, as on a server, the plugin installs no hooks.
- The conflict model is **last-delivery-wins per tab with no arbitration**. Simultaneous writes in two tabs can diverge; a server refetch (`invalidate`) re-converges them.

---

<a id="olasentities"></a>

# @kontsedal/olas-entities

Entity normalization as a plugin. Define entities at module scope. The plugin walks every cache write, indexes the entities it finds by `id`, and back-propagates an update into every query holding that entity. Its store is a service: `ctx.inject(Entities)` in a controller, `root.inject(Entities)` outside one.

```ts
import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import { defineEntity, Entities, entitiesPlugin } from '@kontsedal/olas-entities'

type Post = { id: string; title: string; authorId: string }

export const PostEntity = defineEntity<Post>({
  name: 'Post',
  idOf: (v) => (typeof v.id === 'string' && 'title' in v ? v.id : null),
})

const posts = defineController((ctx) => {
  const entities = ctx.inject(Entities)
  return {
    rename: (id: string, title: string) => entities.update(PostEntity, id, { title }),
  }
})

const root = createRoot(posts, {
  deps: {},
  queries: queryEngine(),
  plugins: [entitiesPlugin({ entities: [PostEntity] })],
})
root.api.rename('p1', 'Renamed')
// every query whose data contains p1 is patched and notified (one batched write).
```

The store has `signal(entity, id)`, `get`, `upsert`, `update(entity, id, patch, { merge })`, `remove`, `list`, `entries` and `bindings`. `remove` drops the entity from the store and leaves the queries that hold it as they are. `update` finds the entity in each entry's current data, so a patch lands where the entity is now. Regular and infinite queries are both walked, and each root gets its own store. In a development build, each update reports its fan-out on the plugin's devtools lane. Full surface: [package README](packages/entities/README.md).

---

<a id="olasrealtime"></a>

# @kontsedal/olas-realtime

Composables over a consumer-supplied `RealtimeService` on `ctx.deps.realtime`. Each one takes the controller's `ctx`, so augment `AmbientDeps` with `realtime: RealtimeService` once:

- `createRealtimePatcher<TEvent>(ctx, channel, handlers)` — subscribe to a realtime channel and dispatch per-event-type handlers, keyed by the `event.type` discriminant. Each handler receives its own variant, `Extract<TEvent, { type: K }>`, and a `'*'` handler sees every event. Fold each event into the cache with a canonical `write` on a bound handle, `bindQuery(ctx, query, { origin: 'realtime' })`. The push is data that is already true, and the origin keeps cross-tab from mirroring a push that every tab receives.
- `createLiveStream<TEvent>(ctx, channel, { capacity, flushMs, rafFlush, onDrop })` — capped tail buffer and coalesced writes for high-rate streams (logs, metrics, presence). **`pause()` tears down the subscription — events arriving during a pause are LOST** (only already-buffered events survive); recover a gap with `onReconnect` and a query `invalidate`.
- `channel`, for both, is a name or a `ReadSignal<string>`. A new name moves the subscription to the new channel, so a per-route room needs no rebuilt controller. A live stream also empties its buffer on the change.
- `createConnectionState(ctx): ReadSignal<ConnectionState>`, where `ConnectionState` is `'connected' | 'reconnecting' | 'offline' | 'unknown'`. Backed by the optional `RealtimeService.onConnectionChange`. With a reporter it starts optimistically `'connected'` and tracks changes. **Without one it reports `'unknown'`**, because it cannot observe the state.
- `onReconnect(ctx, fn)` — run `fn` on a transition back to `'connected'` (not on the initial value). The canonical "invalidate queries that missed updates during the disconnect" trigger. It shares the transport's `onConnectionChange` subscription with every `createConnectionState` on the same `RealtimeService`, so the transport sees one listener.

Full surface lives in [`packages/realtime/README.md`](packages/realtime/README.md). The package ships no transport. Wire your own `RealtimeService`, such as a WebSocket, SSE, Pusher, Ably or Supabase Realtime client, on `ctx.deps`.

---

<a id="olasmutationqueue"></a>

# @kontsedal/olas-mutation-queue

**Best-effort** persistent, replay-safe queue for mutations defined with `meta: { persist: true }`. It replays a run across a reload or a network reconnect instead of dropping it. A plugin, whose service lives under the `MutationQueue` scope.

```ts
import { createMutation, createRoot, defineController, defineMutation, queryEngine } from '@kontsedal/olas-core'
import { MutationQueue, mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

export const addComment = defineMutation({
  id: 'comments/add',
  mutate: async (vars: { idempotencyKey: string; text: string }, { signal }) => {
    const res = await fetch('/api/comments', { method: 'POST', body: JSON.stringify(vars), signal })
    if (!res.ok) throw new Error('comment failed')
  },
  meta: { persist: true },
})

const thread = defineController((ctx) => {
  const add = createMutation(ctx, addComment)
  const queue = ctx.inject(MutationQueue)
  return { add, retryNow: () => queue.replayNow() }
})

const root = createRoot(thread, {
  deps: {},
  queries: queryEngine(),
  plugins: [mutationQueuePlugin({ storage: localStorageAdapter(), keyPrefix: 'my-app/mutations/v1' })],
})
```

### `mutationQueuePlugin(options): OlasPlugin`

```ts nocheck
type MutationQueueOptions = {
  storage: StorageAdapter          // durable store (MUST implement keys())
  keyPrefix: string                // required namespace, e.g. '<app>/mutations/v1'
  maxAttempts?: number             // total replay attempts across loads. Default 5
  ttlMs?: number                   // drop entries older than this. Default Infinity
  backoffMs?: number               // exponential cross-load backoff base. Default 0
  maxBackoffMs?: number            // backoff cap. Default 60_000
  maxEntryBytes?: number           // soft per-entry size warning. Default 64 * 1024
  dedupeBy?: (mutationId: string, variables: unknown) => string | undefined
  migrate?: (raw: unknown, fromVersion: number) => QueueEntry | null
  onReplayError?: (err: unknown, entry: QueueEntry) => void       // gave up (exhausted / TTL / unknown id)
  onReplayAttempt?: (err: unknown, entry: QueueEntry) => void     // non-terminal failure (will retry)
  onReplaySettle?: (entry: QueueEntry, result: unknown, queries: QueryHost) => void // reconcile cache
  onWarn?: (message: string, cause?: unknown) => void
}

type MutationQueueService = { replayNow(): Promise<void> }   // ctx.inject(MutationQueue)
```

- Nothing persists by default. Only a `defineMutation` definition with `meta: { persist: true }` is queued, because a replay needs the registered definition.
- The plugin writes each entry to storage before the request goes out, and deletes it on success.
- Replays run on setup, on the `online` event at reconnect, and on `replayNow()`. They go through the core runner, so the definition's `retry` applies, `mutate` gets the root's `deps`, and the run counts toward `waitForIdle()`.
- The Web Locks API coordinates replay across tabs so two of them don't double-POST, with a best-effort `localStorage`-lease fallback.
- A stored entry replays only when its key matches its contents and the registered definition has `meta.persist`, so storage cannot pick a mutation that did not opt in.
- `onReplaySettle` fires after a successful replay. Invalidate the affected queries there, through `queries.invalidate(id, key)`; without it, subscribers stay stale.
- **Best-effort, not "durable":** at-least-once until success, with the server's `idempotencyKey` check as the authoritative gate. Causal ordering holds only within one mutation `id`.

Full contract and limits: [package README](packages/mutation-queue/README.md).

---

<a id="olasrouter"></a>

# @kontsedal/olas-router

Bridge TanStack Router and React Router v6 route state into scope-injectable signals.

```ts
import { computed, createRoot, defineController } from '@kontsedal/olas-core'
import { createRouterAdapter, RouteParamsScope } from '@kontsedal/olas-router'

const userPage = defineController((ctx) => {
  const params = ctx.inject(RouteParamsScope)
  const userId = computed(() => params.value.userId)
  return { userId }
})

const adapter = createRouterAdapter()
const root = createRoot(userPage, { deps: {}, plugins: [adapter.plugin] })
```

### `createRouterAdapter(initial?: RouteState): RouterAdapter`

```ts nocheck
type RouteState = {
  params?: Record<string, string | undefined>   // string|undefined matches optional segments
  search?: Record<string, unknown>
  pathname?: string
}
type RouterAdapter = {
  readonly plugin: OlasPlugin                   // → createRoot({ plugins: [adapter.plugin] })
  readonly Bridge: (props: {
    params: Record<string, string | undefined>
    search?: Record<string, unknown>
    pathname?: string
    children?: ReactNode
  }) => ReactElement | null
}
```

Install `adapter.plugin` in `createRoot({ plugins })`; it provides the three route scopes. Mount `<adapter.Bridge params={…} search={…} pathname={…}>` inside `<OlasProvider>`, and read route state in controllers via `ctx.inject(RouteParamsScope)`, `RouteSearchScope` and `RoutePathnameScope`. They resolve to `ReadSignal`s of `Record<string, string | undefined>`, `Record<string, unknown>` and `string`.

On the **server**, seed with `createRouterAdapter(initial)`. The Bridge only pushes in a client-only `useLayoutEffect`, so without seeding the route signals are empty for the whole server render. The first client render is likewise empty until the effect runs, so guard route-dependent queries with `enabled: () => params.value.id !== undefined`. Full surface: [package README](packages/router/README.md).

---

<a id="olaseslintplugin"></a>

# @kontsedal/olas-eslint-plugin

Eight syntax-only lint rules for the mistakes the types cannot see, such as a React hook in a controller factory or an optimistic write whose snapshot no code settles. The default export is the plugin, with `rules` and two flat configs, `recommended` and `strict`.

```js
// eslint.config.js
import olas from '@kontsedal/olas-eslint-plugin'

export default [olas.configs.recommended]
```

The rules and what each one catches: [package README](packages/eslint-plugin/README.md).

---

<a id="olascodemod"></a>

# @kontsedal/olas-codemod

The 0.8 → 1.0 migration CLI, on ts-morph:

```bash
npx @kontsedal/olas-codemod 1.0 [--tsconfig <path>] [--dry] [paths...]
```

It rewrites every mechanical rename and lists the sites it cannot rewrite safely as `file:line` TODOs. The upgrade guide around it is [Upgrading from 0.8 to 1.0](MIGRATING.md#upgrading-from-08-to-10). The package also exports `runCodemod` and the transforms for programmatic use. Every transform, and what to do before a run: [package README](packages/codemod/README.md).

---

## Where to go next

- [`README.md`](README.md) — guided tour with progressive examples.
- [`SPEC.md`](SPEC.md) — full design with rationale and edge cases.
- [`PLUGINS.md`](PLUGINS.md) — how to write a plugin, and how to test one.
- [`RECIPES.md`](RECIPES.md) — reusable composables and integration patterns.
- [`MIGRATING.md`](MIGRATING.md) — [upgrading from 0.8 to 1.0](MIGRATING.md#upgrading-from-08-to-10), and coming from TanStack Query or Redux Toolkit.
- [`.wiki/pitfalls/`](.wiki/pitfalls) — recorded footguns. Every cross-reference above lands here.
- [`BACKLOG.md`](BACKLOG.md) — proposed extensions and deferred ideas.
