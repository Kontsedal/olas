# Olas

**State and logic that lives outside the UI tree.**

Olas pulls everything that *isn't* rendering — fetching, mutations, forms, business rules, cross-screen coordination — into a parallel tree of typed controllers. Your components stay thin and your logic becomes plain TypeScript you can read top to bottom and test without spinning up a renderer.

```ts
import { defineController, signal } from '@olas/core'

export const counter = defineController(() => {
  const count = signal(0)
  return {
    count,
    increment: () => count.update((n) => n + 1),
  }
})
```

That's a controller. It's a function that returns an object. Components subscribe to it, call methods on it, and never own its lifetime.

---

## Table of contents

- [Why](#why)
- [Install](#install)
- [A five-minute tour](#a-five-minute-tour)
  - [Signals — typed boxes that notify](#1-signals--typed-boxes-that-notify)
  - [Controllers — group state and behavior](#2-controllers--group-state-and-behavior)
  - [Reading from React](#3-reading-from-react)
  - [Async data with `defineQuery`](#4-async-data-with-definequery)
  - [Writes with mutations](#5-writes-with-mutations)
  - [Forms](#6-forms)
- [Common recipes](#common-recipes)
- [How it scales](#how-it-scales)
- [Packages](#packages)
- [Examples](#examples)
- [How it compares](#how-it-compares)
- [Learn more](#learn-more)

---

## Why

Most apps end up in one of three places:

1. **State inside components.** Easy at first. At scale it sprawls — the same data fetched twice, side effects tangled with renders, tests boot a renderer to verify a single rule.
2. **One big store.** Scalable but blunt. Everything is global, ownership is implicit, lifetimes are forever.
3. **Hooks at the top of pages.** Hides ownership. Two pages mounting the same hook re-fetch instead of sharing. Lifecycle is "whatever React does."

Olas takes a different shape. There's a **controller tree** that mirrors your app's *features* (not your component tree). Each controller owns its slice — its signals, its queries, its mutations — and is disposed explicitly when the feature unmounts. Components are read-only renderers that subscribe to controllers via small adapter hooks.

The practical wins:

- **Logic without renderers.** A controller is a function. Tests pass in fake `deps`, call methods, and assert against signals. No `render(<App />)`, no Testing Library, no fake timers chasing effect flushes.
- **Explicit lifetimes.** Every field, query, mutation, and child controller dies with its parent. No "what owns this subscription?" mystery.
- **Shared queries by default.** Two controllers subscribing to the same query share one fetch and one cache entry. The same primitive scales from "one widget" to "every screen on the dashboard."
- **Framework-agnostic core.** `@olas/core` never imports React. The React adapter is ~200 lines. The same controllers can drive Vue, Svelte, or vanilla DOM with a small adapter.

---

## Install

```bash
pnpm add @olas/core @olas/react @preact/signals-core react
# optional
pnpm add @olas/persist @olas/zod @olas/devtools zod
```

`@preact/signals-core` is a peer dep on `@olas/core` — the library does not bundle it.

---

## A five-minute tour

Six concepts, each smaller than the last. By the end you can read any Olas codebase.

### 1. Signals — typed boxes that notify

```ts
import { signal, computed, effect } from '@olas/core'

const count = signal(0)
const double = computed(() => count.value * 2)

count.set(5)
console.log(double.value)         // 10

effect(() => {
  console.log('count is', count.value)
})
count.update((n) => n + 1)        // logs "count is 6"
```

A `signal` is a typed cell with `.value` (read) and `.set(...)` / `.update(fn)` (write). `computed(...)` derives a read-only signal that recomputes when its dependencies change. `effect(...)` runs side effects, re-running when *its* dependencies change.

Olas wraps [`@preact/signals-core`](https://github.com/preactjs/signals) behind these types. It's small (~1 kB), fast, and glitch-free.

### 2. Controllers — group state and behavior

A controller is a function from `ctx` to an API object.

```ts
import { defineController, signal } from '@olas/core'

const counter = defineController((ctx) => {
  const count = signal(0)

  ctx.effect(() => {
    document.title = `Count: ${count.value}`
  })

  return {
    count,
    increment: () => count.update((n) => n + 1),
    reset: () => count.set(0),
  }
})
```

`ctx` is a factory bound to *this* controller's lifetime. Anything created through `ctx` — effects, child controllers, fields, queries, mutations, emitters — is disposed when the controller is disposed.

Mount the controller as a root once, near your app entry point.

```ts
import { createRoot } from '@olas/core'

const root = createRoot(counter, { deps: {} })

root.increment()
console.log(root.count.value)     // 1

root.dispose()                    // tears down the effect, signals, everything
```

`deps` is required (more on this in [Dependency injection](#dependency-injection)). For trivial apps, `{}` is fine.

### 3. Reading from React

```tsx
// main.tsx
import { createRoot as createReactRoot } from 'react-dom/client'
import { createRoot as createOlasRoot } from '@olas/core'
import { OlasProvider } from '@olas/react'
import { counter } from './counter'
import { App } from './App'

const root = createOlasRoot(counter, { deps: {} })

createReactRoot(document.getElementById('root')!).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>
)
```

Export the api type alongside the controller so components can reach for it without poking at framework types:

```ts
// counter.ts (cont.)
import type { ReadSignal } from '@olas/core'

export type CounterApi = {
  count: ReadSignal<number>
  increment: () => void
  reset: () => void
}
```

```tsx
// App.tsx
import { use, useRoot } from '@olas/react'
import type { CounterApi } from './counter'

export function App() {
  const api = useRoot<CounterApi>()
  const count = use(api.count)

  return (
    <div>
      <p>{count}</p>
      <button onClick={api.increment}>+</button>
      <button onClick={api.reset}>reset</button>
    </div>
  )
}
```

`use(signal)` subscribes a component to one signal. `useRoot<Api>()` resolves the controller's public API from the provider. The component is a thin renderer — all behavior lives on `api`.

### 4. Async data with `defineQuery`

For data that comes from the network and might be shared across screens, define a query at module scope:

```ts
import { defineQuery } from '@olas/core'

export const userQuery = defineQuery({
  key: (id: string) => [id],
  fetcher: async ({ signal }, id) => {
    const res = await fetch(`/api/users/${id}`, { signal })
    if (!res.ok) throw new Error(res.statusText)
    return res.json() as Promise<{ id: string; name: string; email: string }>
  },
  staleTime: 30_000,
})
```

Subscribe to it from a controller. `ctx.use` returns an `AsyncState<T>` — eight signals you can read individually.

```ts
import { defineController } from '@olas/core'

export const userProfile = defineController((ctx, props: { id: string }) => {
  const user = ctx.use(userQuery, () => [props.id])

  return { user }
})
```

In a component, `useQuery` collapses those eight signals into one render:

```tsx
import { useQuery, useRoot } from '@olas/react'

function UserCard() {
  const api = useRoot<UserProfileApi>()
  const { data, isLoading, error } = useQuery(api.user)

  if (isLoading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  return <h1>{data?.name}</h1>
}
```

**Two controllers subscribing to the same `userQuery` with the same id share one fetch and one cache entry.** When the last subscriber disposes, the entry is collected after `gcTime` (5 min default).

### 5. Writes with mutations

```ts
import { defineController } from '@olas/core'

export const userProfile = defineController((ctx, props: { id: string }) => {
  const user = ctx.use(userQuery, () => [props.id])

  const updateName = ctx.mutation<string, void>({
    mutate: async (newName, signal) => {
      const res = await fetch(`/api/users/${props.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
        signal,
      })
      if (!res.ok) throw new Error('save failed')
    },
    onMutate: (newName) =>
      userQuery.setData(props.id, (prev) => {
        if (!prev) throw new Error('updateName before user loaded')
        return { ...prev, name: newName }
      }),
    onError: (_err, _vars, snapshot) => {
      snapshot?.rollback()
    },
  })

  return { user, updateName }
})
```

`onMutate` runs an optimistic update *before* the network call and returns a snapshot. If the call fails, `onError` calls `snapshot.rollback()` and the UI reverts.

Three concurrency modes (`parallel` is default):

- `parallel` — every `.run(...)` is independent.
- `latest-wins` — a new `.run(...)` aborts the in-flight one.
- `serial` — runs queue up and execute one at a time.

### 6. Forms

```ts
import { defineController, required, minLength, email } from '@olas/core'

export const signupForm = defineController((ctx) => {
  const form = ctx.form({
    name: ctx.field('', [required('Name is required')]),
    email: ctx.field('', [required(), email()]),
    password: ctx.field('', [minLength(8, 'Min 8 characters')]),
  })

  return {
    form,
    submit: ctx.mutation<void, void>({
      mutate: async () => {
        form.markAllTouched()
        if (!(await form.validate())) throw new Error('invalid')
        const v = form.value.value
        // ...send v.name, v.email, v.password to the server
      },
    }),
  }
})
```

A `Form` aggregates fields (and nested forms, and `FieldArray`s) into a single typed `value` signal plus `isValid`, `isDirty`, `touched`, `isValidating`. Components subscribe one field at a time with `useField`:

```tsx
import { useField } from '@olas/react'

function NameInput({ field }: { field: Field<string> }) {
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

For schema-driven forms, `@olas/zod` walks a `z.object(...)` tree and emits the matching `Form` / `Field` / `FieldArray` structure with validators auto-attached:

```ts
import { z } from 'zod'
import { formFromZod } from '@olas/zod'

const Schema = z.object({
  name: z.string().min(2),
  age: z.number().min(0),
})

const form = formFromZod(ctx, Schema)
// form.value: ReadSignal<{ name: string; age: number }>
```

That's the whole tour. Everything else in Olas is variations on these six pieces.

---

## Common recipes

### Dependency injection

`deps` is a typed object passed to `createRoot` and available everywhere as `ctx.deps`. Use it for anything the app talks to externally (api clients, routers, analytics, the current time).

```ts
// deps.ts
export interface AppDeps {
  api: { getUser(id: string): Promise<User> }
  router: { navigate(path: string): void }
}

declare module '@olas/core' {
  interface AmbientDeps extends AppDeps {}
}
```

```ts
const root = createRoot(appController, {
  deps: {
    api: realApiClient,
    router: realRouter,
  },
})
```

In tests, pass in fakes — no mocking framework needed.

### Cross-controller communication — emitters

For "controller A fires an event, controller B reacts," use an emitter on `ctx.deps` (or a `defineScope` for shared in-tree state).

```ts
const activity = defineController((ctx) => {
  const log = signal<string[]>([])
  ctx.on(ctx.deps.activity, (msg) => log.update((l) => [...l, msg]))
  return { log }
})
```

### Optimistic UI with rollback

Pattern shown above in [§5](#5-writes-with-mutations). The key rule: `onMutate` returns a snapshot; `onError` calls `snapshot.rollback()`. Rollback is automatic *only* on abort (e.g., a `latest-wins` mutation superseded). For normal errors, do it explicitly.

### Persisted state

```ts
import { signal } from '@olas/core'
import { usePersisted } from '@olas/persist'

const theme = signal<'light' | 'dark'>('light')
usePersisted(ctx, 'theme', theme)
```

`usePersisted` reads the saved value on construction and writes through on every change. Works for any signal-shaped source (`signal`, `field`, or anything exposing `.value` / `.set` / `.subscribe`). Cross-tab sync via `crossTab: true`.

### SSR — `dehydrate` and `hydrate`

```ts
// server
const root = createRoot(app, { deps: serverDeps })
renderToString(<OlasProvider root={root}><App /></OlasProvider>)
await root.waitForIdle()
const state = root.dehydrate()
// inline `state` into the HTML response
```

```ts
// client
const root = createRoot(app, { deps: clientDeps, hydrate: state })
```

The cache survives the boundary. Queries already in `state` don't refetch on the client.

### Devtools

```tsx
import { DevtoolsLauncher } from '@olas/devtools'

<OlasProvider root={root}>
  <App />
  <DevtoolsLauncher root={root} />
</OlasProvider>
```

A floating button opens a panel with the controller tree, cache timeline, and mutation log. Gate behind `import.meta.env.DEV` for prod builds.

---

## How it scales

| Concern | What changes as the app grows |
|---|---|
| **Many features** | Add more controllers; compose them via `ctx.child(...)`. The tree mirrors features, not screens. |
| **Shared data** | `defineQuery` at module scope. Multiple subscribers share one fetch automatically. |
| **Many roots / tests in parallel** | Each `createRoot(...)` is isolated; query entries live per-root. Tests run in parallel without leaking state. |
| **User-driven sub-trees** | `ctx.attach(...)` gives you a child controller plus a `dispose()` handle — close the panel, the sub-tree (and its subscriptions) goes with it. |
| **Cross-tree config** | `defineScope<T>()` + `ctx.provide(scope, value)` / `ctx.inject(scope)` — typed cross-tree data without prop drilling. |

For more depth, every concept above maps to a section in [`SPEC.md`](SPEC.md).

---

## Packages

| Package | What it gives you |
|---|---|
| [`@olas/core`](packages/core) | Everything: signals, controllers, queries, mutations, forms, scopes, SSR, devtools event bus. |
| [`@olas/react`](packages/react) | React adapter — `OlasProvider`, `useRoot`, `use`, `useQuery`, `useField`, `KeepAlive`, `useSuspendOnHidden`. |
| [`@olas/persist`](packages/persist) | `usePersisted` + `localStorage` adapter. |
| [`@olas/zod`](packages/zod) | `zodValidator(schema)` + `formFromZod(ctx, schema)`. |
| [`@olas/devtools`](packages/devtools) | In-app `<DevtoolsPanel>` + floating launcher consuming `root.__debug`. |

Outstanding work — additional storage adapters, normalization, Vue/Svelte adapters, browser-extension devtools — is tracked in [`BACKLOG.md`](BACKLOG.md).

---

## Examples

Three runnable example apps live in [`examples/`](examples). Each is a real (small) application — not a snippet — with its own dev server and unit tests.

| App | Stack | What it shows |
|-----|-------|---------------|
| [`stock-ticker`](examples/stock-ticker) | **Vanilla TS** — no UI framework | Signals, computed, effect, emitter, throttled/debounced, `defineQuery` + `refetchInterval`, `usePersisted` watchlist, SVG sparklines. |
| [`kanban`](examples/kanban) | React + Devtools | All three mutation concurrency modes, optimistic snapshot rollback, `formFromZod` + `FieldArray`, `defineScope`, error-toast retry, activity feed, mounted `<DevtoolsPanel>`. |
| [`reader-ssr`](examples/reader-ssr) | React + SSR | `waitForIdle → dehydrate → hydrate` round-trip, paginated `defineQuery`, `useSuspendOnHidden`, `usePersisted` × 3 (bookmarks, theme, reading progress), `onError` root option. |

```bash
pnpm install
pnpm --filter @olas/example-kanban dev      # or stock-ticker, reader-ssr
pnpm --filter @olas/example-kanban test
```

Every business-logic surface in these examples is covered by a controller test that uses `createTestController`, `fakeField`, and `fakeAsyncState` from `@olas/core/testing` — no rendered components.

---

## How it compares

These are honest, terse sketches. None of them are reasons to leave a tool you're happy with.

**vs. Redux Toolkit / Zustand.** A store is one big object. A controller tree is many small objects, each owning its slice and lifetime. Olas has no reducers, no slices, no selectors — you read signals directly, you call methods directly. The "selector" problem (re-render on unrelated changes) doesn't exist because subscriptions are per-signal.

**vs. TanStack Query + Zustand.** TanStack handles the network; Zustand handles the rest; gluing them together is application code. Olas is one model: queries, mutations, and ephemeral state all live in the same controller, with the same lifetime, in the same place.

**vs. MobX.** Both are signal-graph-based. MobX is class-oriented with decorators; Olas is function-oriented with a `ctx` factory and explicit lifetime ownership. Tests in Olas don't need MobX-runtime configuration.

**vs. Effector / XState.** Effector is signal-graph-based at a finer grain (effects, stores, events as primitives). XState is state-machine-first. Olas sits between: signal-graph for data, but with controllers as the unit of ownership.

---

## Learn more

- [`API.md`](API.md) — complete API reference: every export, signature, signature-typechecked example, gotchas. The "leave no questions" doc.
- [`SPEC.md`](SPEC.md) — authoritative design. Read top to bottom or jump by `§N.M` section.
- [`RECIPES.md`](RECIPES.md) — reusable user composables (`useDebounced`, `usePagination`, `useSubmit`, `useInlineEdit`, `useTail`, `useRealtimePatcher`).
- [`MIGRATING.md`](MIGRATING.md) — coming from TanStack Query or Redux Toolkit.
- [`.wiki/index.md`](.wiki/index.md) — codebase wiki: per-module pages, design decisions, recorded pitfalls.
- [`.wiki/overview.md`](.wiki/overview.md) — one-page architecture.
- [`BACKLOG.md`](BACKLOG.md) — proposed extensions, post-v1 packages, deferred ideas.
- [`CLAUDE.md`](CLAUDE.md) — orientation for AI assistants working in this repo.

---

## Commands

```bash
pnpm install                                       # link workspace + install
pnpm typecheck                                     # tsc --noEmit per package
pnpm lint                                          # biome check .
pnpm test                                          # vitest run (all packages)
pnpm build                                         # tsdown per package → dist/{mjs,cjs,d.mts,d.cts}

pnpm wiki:lint                                     # check .wiki/ for broken refs
```

CI = `install → typecheck → lint → test → build`. 248 tests, all green.

---

## License

MIT.
