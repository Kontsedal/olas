# Concepts

Olas splits an app into two trees. The controller tree owns the state and the logic, and the component tree draws it. This page describes the model in the order you meet it, and says briefly why each part is shaped the way it is. [SPEC.md](https://github.com/Kontsedal/olas/blob/main/SPEC.md) is the full contract, cited here as §N.M.

```text
Component tree (draws)                Controller tree (owns state and logic)

App                                   app            ← root, from createRoot
├── Toolbar ─── useValue ───────────▶ ├── toolbar
└── BoardPage ─ useQuery ───────────▶ └── board
                                          ├── createQuery(ctx, boardQuery)
                                          ├── createMutation(ctx, …)
                                          └── cardEditor  ← attached while open
```

## Two trees

A controller holds everything that decides what happens: fetching, cached and local state, writes, validation, derived data and multi-step flows. A component subscribes to the signals a controller exposes, renders them, and wires input back to the controller's methods. The only state a component keeps is gesture state, such as a drag rectangle that means nothing once the gesture ends (§16.5).

The components reach into the controller tree, and the controllers know nothing about components. That one-way arrow buys two things:

- **Logic runs without a renderer.** A test constructs a controller in Node, calls its methods and reads its signals.
- **The view layer is replaceable.** The logic imports no framework, so moving to another one means swapping a thin adapter (§16).

## Controllers and the tree

`defineController(factory)` returns a definition. The factory runs once per instance and receives a fresh `ctx`, bound to that instance. The object it returns is the controller's public API, and TypeScript infers it. Anything the factory does not return stays private to its closure (§1.7).

The factory is synchronous and does not return a promise (§1.4). Async work lives in queries, mutations and effects, which the factory sets up and leaves running. This keeps construction a plain function call, which a test can make, and keeps the tree traceable. `@kontsedal/olas-eslint-plugin` flags an `async` factory.

Parents construct their children and pass them props (§1.3). A controller cannot reach a sibling or look up an ancestor, apart from the typed scopes described below. `ctx` offers four ways to make a child:

| Method | What it makes | Typical use |
|---|---|---|
| `ctx.child(def, props)` | A child that lives as long as its parent. Returns its api. | The fixed parts of a screen. |
| `ctx.attach(def, props)` | A child with its own `{ api, dispose, suspend, resume }` handle. | A panel, a modal, a wizard step. |
| `ctx.collection(options)` | A keyed set of children, reconciled from a signal of items. | A list whose rows have behavior. |
| `ctx.lazyChild(loader, props)` | A code-split child, constructed once its module loads. | A heavy panel or a route. |

```ts file=board.ts
import { type CtrlApi, defineController, signal } from '@kontsedal/olas-core'

const toolbar = defineController(() => {
  const compact = signal(false)
  return { compact, toggle: () => compact.update((value) => !value) }
})

const cardEditor = defineController((ctx, props: { cardId: string }) => {
  const title = signal('')
  ctx.onDispose(() => console.log(`editor for ${props.cardId} closed`))
  return { title }
})

type Editor = { api: CtrlApi<typeof cardEditor>; dispose: () => void }

export const board = defineController((ctx) => {
  const editor = signal<Editor | null>(null)
  return {
    toolbar: ctx.child(toolbar, undefined),
    editor,
    open(cardId: string) {
      editor.peek()?.dispose()
      editor.set(ctx.attach(cardEditor, { cardId }))
    },
    close() {
      editor.peek()?.dispose()
      editor.set(null)
    },
  }
})
```

A controller is a unit of testable behavior, and each instance costs allocations and subscriptions. Thousands of plain rows are data, so keep them as signals in one parent controller rather than one controller per row (§11.2).

## Lifetimes

Most controllers have two states, active and disposed. A controller is disposed when its parent is, when `root.dispose()` runs, when its `attach` handle's `dispose()` is called, or when a collection drops its key. Disposal is recursive and synchronous (§4):

- Everything the controller created goes with it: children, effects, queries, mutations, fields, emitters and subscriptions.
- Teardown runs in **reverse registration order**, in one pass over all kinds. An `onDispose` hook registered after an effect runs before that effect is torn down ([pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/dispose-order-is-registration-order.md)).
- After disposal, `ctx` is dead. A later `ctx.effect(...)` or `createQuery(ctx, …)` throws `[olas] effect() called after the controller was disposed`, naming the call.

Disposing does not throw away shared data. A query entry that loses its last subscriber stays in the cache for `gcTime`, five minutes by default. A user who navigates back within that window gets a new controller that shows the cached data at once. It refetches in the background only if the entry is past its `staleTime`.

### Suspend and resume

A subtree can also be suspended and resumed, for a view that is coming back soon, such as the hidden tab of two (§4.1). Suspension keeps the controllers and their state:

| On suspend | On resume |
|---|---|
| Effects are torn down, and their cleanups run. | Effects run again. |
| Each query subscription releases its entry, so the entry's `gcTime` timer starts. The subscription keeps reporting the last data it showed. | Subscriptions re-acquire their entries. An entry past its `staleTime` refetches, and a collected one fetches from scratch. |
| `refetchInterval` stops, because the interval belongs to an entry with subscribers. | The interval restarts with the subscription. |
| A fetch already in flight runs to completion. | |
| `ctx.onSuspend` hooks run. | `ctx.onResume` hooks run. |

```ts
import { defineController, signal } from '@kontsedal/olas-core'

export const clock = defineController((ctx) => {
  const ticks = signal(0)
  ctx.effect(() => {
    const id = setInterval(() => ticks.update((n) => n + 1), 1000)
    return () => clearInterval(id) // runs on suspend and on dispose
  })
  return { ticks }
})
```

`root.suspend()` and `root.resume()` act on the whole tree, an `attach` handle on its subtree, and `collection.suspendItem(key)` on one row. A child suspended through its own handle stays suspended through a whole-tree suspend and resume cycle, so a virtualized list's hidden rows do not all wake at once.

**Suspend is not a navigation cache.** A suspended subtree stays in memory for the rest of the session, with its signals, fields and children. For "the user might come back", dispose it and let `gcTime` keep the data (§4.2). `root.suspend({ maxIdleTime: 5 * 60_000 })` disposes the root if nothing resumes it in time (§4.3).

## `ctx`: the tree and the lifetime

`ctx` carries what binds to one controller's tree and lifetime (§3.2):

- children: `ctx.child`, `ctx.attach`, `ctx.collection` and `ctx.lazyChild`;
- effects and events: `ctx.effect`, `ctx.emitter` and `ctx.on`;
- scopes: `ctx.provide` and `ctx.inject`;
- lifecycle hooks: `ctx.onDispose`, `ctx.onSuspend` and `ctx.onResume`;
- `ctx.deps`, and `ctx.debug` for the devtools.

The primitives that build a lifetime-owned **thing** are free functions that take `ctx` first: `createField`, `createForm`, `createFieldArray`, `createCache`, `createQuery`, `createMutation` and `bindQuery`. What they create belongs to that controller and is disposed with it. Anything that needs no lifetime takes no `ctx` at all: `signal`, `computed`, `effect`, `batch`, the `define*` functions, `queryEngine`, `debounced` and `throttled`.

```ts
import { type Ctx, createField, debounced } from '@kontsedal/olas-core'

// A composable is a function that takes ctx. Name it create*, like core does.
export function createSearchBox(ctx: Ctx, delayMs = 300) {
  const term = createField<string>(ctx, '') // owned by the caller's controller
  const settled = debounced(term, delayMs) // standalone: no ctx
  ctx.onDispose(() => settled.dispose())
  return { term, settled }
}
```

Why free functions rather than methods on `ctx`: a method on `ctx` is reachable from `createRoot`, so a bundler cannot drop it. When fields and queries were methods, every app shipped the forms and query code whether it used them or not. As named exports, a controller that builds no form ships no form code. SPEC §3.2 measures a controllers-only bundle at 20.1 KB before the change and 6.35 KB after it, gzipped.

The naming carries meaning. A `define*` function builds a module-scope value with no controller, such as `defineQuery`. A `create*` function binds a thing to a controller's lifetime, such as `createQuery`. A composable named `use*` would read as a React hook, and the lint rule `no-react-hooks-in-controllers` reports any `use*` call inside a factory.

Every primitive can be called at any point in the controller's active life, not only during construction (§3.4). Each controller-bound primitive also has its own idempotent `.dispose()`, for things that come and go.

## The root handle

`createRoot(def, options)` instantiates the top controller and returns a frozen handle. The controller's API is on `root.api`, and the root's own controls sit beside it:

| Member | What it does |
|---|---|
| `api` | What the root controller's factory returned. |
| `dispose()` | Tears down the tree, then the plugins in reverse order, then the cache. Idempotent. |
| `suspend(options?)`, `resume()` | Freeze and thaw the whole tree. `maxIdleTime` auto-disposes. |
| `waitForIdle()` | Resolves when no fetch, no mutation and no plugin-tracked work is in flight. |
| `dehydrate()`, `hydrate(state)` | Serialize the query cache, and apply a serialized one (§15). |
| `bindQuery(query)` | Imperative operations on one query, bound to this root. |
| `inject(scope)` | Resolve a scope from outside the tree, as the root controller would. |
| `debug` | The devtools event bus. |

```ts
import { createRoot } from '@kontsedal/olas-core'
import { board } from './board'

const root = createRoot(board, { deps: {} }) // board reads no services
root.api.open('card-1')
root.suspend({ maxIdleTime: 5 * 60_000 })
root.resume()
root.dispose()
```

Why a handle, not the api with controls mixed in: an intersection would reserve names in your namespace. A media-player controller could not expose its own `suspend`, and every new root control in a later release would break an app that already used the name. The handle keeps the api yours, and `root.api` can be any value, a number included ([decision](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/root-handle-separate.md)). The adapters hide the difference: React's `useRoot()` returns `root.api`.

## Signals and computeds

Everything reactive in Olas is a signal. `signal(initial)` is a typed cell, and `computed(fn)` derives a read-only signal from the signals `fn` reads. Both are glitch-free: a computed does not read a half-updated graph.

```ts
import { batch, computed, signal } from '@kontsedal/olas-core'

const price = signal(20)
const quantity = signal(2)
const total = computed(() => price.value * quantity.value)

price.set(25)
quantity.update((n) => n + 1)
total.value // 75
total.peek() // 75, without registering a dependency

batch(() => {
  price.set(10)
  quantity.set(1)
}) // subscribers see one change, not two
```

A `ReadSignal<T>` has `.value`, `.peek()`, `.subscribe(fn)` and `.subscribeChanges(fn)`, and a `Signal<T>` adds `.set` and `.update`. The same read surface runs through the library. A `Field` is a `ReadSignal` of its value, every property of a query's `AsyncState` is a `ReadSignal`, and a `Form` is a `ReadSignal` of its typed value. The adapters therefore need one way to read anything.

Inside a controller, use `ctx.effect(fn)` rather than the standalone `effect(fn)`, so the effect is torn down with its controller. An effect records as dependencies the signals it read on its most recent run, so read the tracked signals before any early return ([pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/suspended-effects-lose-deps.md)).

Olas builds on `@preact/signals-core` but wraps it behind its own types (§1.5). The wrapper gives the library a stable `Signal<T>` of its own and the `.set` and `.update` methods.

## Deps and `AmbientDeps`

`deps` is an object of services passed to `createRoot`: API clients, a router, analytics, the clock. Every controller reads it as `ctx.deps`, and every query fetcher and `mutate` receives it as `{ signal, deps }`. Controllers do not import service singletons (§10), which is what lets a test hand the whole tree fakes with no module mocking.

Type the services once, for the whole app, by augmenting `AmbientDeps`:

```ts file=deps.ts
import type { ReadSignal } from '@kontsedal/olas-core'

export type User = { id: string; name: string }

export interface UserApi {
  getUser(id: string, signal: AbortSignal): Promise<User>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: UserApi
    online: ReadSignal<boolean>
  }
}
```

After the augmentation, `ctx.deps.api` is a `UserApi` in every controller, with no generics on any signature (§20.3). Without one, each `ctx.deps` value is `unknown`.

`createRoot` infers the type of `deps` from the object you pass, so it does not check that object against `AmbientDeps`. A missing service compiles and shows up at runtime as `undefined`. Add `satisfies AmbientDeps` where the app builds its deps to get the check:

```ts
import { type AmbientDeps, createRoot, signal } from '@kontsedal/olas-core'
import { board } from './board'
import type { UserApi } from './deps'

declare const httpUserApi: UserApi

const deps = { api: httpUserApi, online: signal(true) } satisfies AmbientDeps
const root = createRoot(board, { deps })
```

Two more properties make deps the home for app-wide state. A value can be reactive, such as the `online` signal above, and a `computed` that reads `ctx.deps.online.value` tracks it (§10.1). A subtree can also override part of it: `ctx.child(def, props, { deps: { api: fakeApi } })` swaps `api` for that child and its descendants.

## Scopes

A scope is a typed slot that an ancestor provides and any descendant reads (§10.3). It is for hierarchical data, such as an `orgId` known at the org level and needed five layers down.

```ts
import { defineController, defineScope } from '@kontsedal/olas-core'

export const orgScope = defineScope<{ orgId: string }>({ name: 'org' })

const taskRow = defineController((ctx) => {
  const org = ctx.inject(orgScope) // typed { orgId: string }
  return { orgId: org.orgId }
})

export const orgPage = defineController((ctx, props: { orgId: string }) => {
  ctx.provide(orgScope, { orgId: props.orgId })
  return { row: ctx.child(taskRow, undefined) }
})
```

- `ctx.inject(scope)` walks up the tree. With no provider and no `default`, it throws.
- A deeper `ctx.provide` shadows the ancestor's value for its subtree.
- Above the root controller, a plugin can provide a scope during setup, and `RootOptions.scopes` binds `[scope, value]` pairs that win over a plugin's. A test uses the second to stand in a fake for a plugin's service.
- `root.inject(scope)` resolves a scope from outside every controller.

Why scopes are limited: they trade traceability for convenience, because a consumer's signature does not say who provides its value. Reach for props first, deps for app-wide services, and a scope only when the data is hierarchical and more than about three layers would otherwise pass it unchanged. SPEC §10.3 suggests fewer than ten scopes in a whole app.

## The per-root query engine

A query definition lives at module scope. Its cache entries live in a root. `queryEngine()` is a definition too: each root that adopts it builds its own client, so one engine value at module scope can serve many roots.

```ts
import {
  type AmbientDeps,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'

export const userQuery = defineQuery({
  id: 'users/detail',
  key: (id: string) => [id],
  fetcher: ({ signal, deps }, id) => deps.api.getUser(id, signal),
})

const avatar = defineController((ctx, props: { userId: string }) => ({
  user: createQuery(ctx, userQuery, () => [props.userId]),
}))

const page = defineController((ctx) => ({
  header: ctx.child(avatar, { userId: 'u1' }),
  sidebar: ctx.child(avatar, { userId: 'u1' }), // same key: one entry, one fetch
}))

declare const deps: AmbientDeps
const root = createRoot(page, {
  deps,
  queries: queryEngine({ defaults: { staleTime: 60_000, retry: 1 } }),
})
root.bindQuery(userQuery).invalidate('u1')
```

Inside one root, subscribing is sharing. Two controllers that subscribe to the same query with the same key share one entry and one fetch, with nothing to wire. Across roots nothing is shared, and that is the point of the design ([decision](https://github.com/Kontsedal/olas/blob/main/.wiki/decisions/per-root-query-client.md)):

- Server rendering builds one root per request, so one user's data cannot reach another's response.
- Tests build one root each, so they run in parallel without leaking entries.
- Two independent features on one page can each own a root.

The engine is explicit for the bundle's sake. `createRoot` does not import the cache code, so a root without `queries` leaves it out, and `createQuery`, `createMutation` and `bindQuery` throw an error that names the fix. A root that has an engine builds its client eagerly, before plugin setup and before the root factory. Some plugins need the cache at startup: the mutation queue replays a previous session's writes during setup.

The `Query` value also carries module-level helpers, such as `userQuery.invalidate('u1')`. They act on the one root that has used the query. Once two live roots have used it, they throw, or reject, as ambiguous. `bindQuery(ctx, query)` inside a controller and `root.bindQuery(query)` outside one name the root explicitly. [Queries](/guide/queries) covers keys, staleness, invalidation and the rest.

## Where plugins fit

A plugin extends every root it is installed in, which suits behavior that cuts across every query and mutation (§13). `definePlugin({ name, setup(host) })` builds a definition, and `createRoot` runs its `setup` once per root, in `plugins` order, before the root factory. Dispose runs them in reverse.

```ts
import { definePlugin } from '@kontsedal/olas-core'

export const writeLogger = definePlugin({
  name: 'write-logger',
  setup(host) {
    host.onDispose(() => console.log('root disposed'))
    return {
      onWrite: (event) => console.log(event.query.id, event.source, event.origin),
    }
  },
})
```

The host gives a plugin the root's `deps`, the cache by query `id` through `host.queries`, the registered mutations through `host.mutations`, network events and `track` for work `waitForIdle()` should wait for. `setup` returns observation hooks such as `onWrite` and `onMutation`, and middleware such as `wrapFetch` and `wrapMutate`. A plugin exposes a service to controllers by providing a scope, and it reads per-query settings from a typed `meta` field. `host.queries` and `host.mutations` are `null` on a root without an engine.

Cross-tab sync, entity normalization, the durable mutation queue and query-cache persistence are all plugins on this contract. [Plugins](/guide/plugins) is the authoring guide.

## Where to go next

- [Getting started](/guide/getting-started) builds one feature with these pieces.
- [Queries](/guide/queries), [Mutations](/guide/mutations) and [Forms](/guide/forms) cover the primitives a controller owns.
- [Testing](/guide/testing) shows how the model pays off in tests.
- The reference has the full types: [`Ctx`](/reference/olas-core.ctx), [`Root`](/reference/olas-core.root), [`RootOptions`](/reference/olas-core.rootoptions) and [`AmbientDeps`](/reference/olas-core.ambientdeps).
