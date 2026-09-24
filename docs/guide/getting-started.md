# Getting started

This page builds one small feature end to end: a todo list that loads from a server, filters itself and renders in React. By the end you have a controller, a root, a component that reads it, and a test that runs the controller in Node with no renderer.

The feature is ordinary on purpose. The point is where each piece lives: the fetching, the state and the rules sit in a controller, and the component only draws what the controller exposes.

## Install

Olas is one core package, one peer dependency and one adapter for your view layer.

```bash
# React
pnpm add @kontsedal/olas-core @preact/signals-core @kontsedal/olas-react react react-dom
# Vue
pnpm add @kontsedal/olas-core @preact/signals-core @kontsedal/olas-vue vue
# Svelte
pnpm add @kontsedal/olas-core @preact/signals-core @kontsedal/olas-svelte svelte
```

- `@kontsedal/olas-core` holds controllers, signals, queries, mutations and forms. It imports no UI framework.
- `@preact/signals-core` is the reactive runtime underneath. Core declares it as a peer dependency and does not bundle it, so your app installs it once.
- The adapter is the package that knows your framework. React needs 18 or later, Vue 3.4 or later, and Svelte 4 or later.

Every package ships ES modules only and needs Node 20.19 or later.

## 1. Describe the service

A controller does not import its API client. It reads services from `ctx.deps`, which the root supplies, so a test can hand it a fake instead. Declare the service's type once, by augmenting `AmbientDeps`:

```ts file=api.ts
// api.ts
export type Todo = { id: string; title: string; done: boolean }

export interface TodoApi {
  listTodos(signal: AbortSignal): Promise<Todo[]>
}

// Types `ctx.deps.api`, and `deps.api` in fetchers, across the whole app.
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: TodoApi
  }
}

export function createHttpApi(baseUrl: string): TodoApi {
  return {
    async listTodos(signal) {
      const res = await fetch(`${baseUrl}/todos`, { signal })
      if (!res.ok) throw new Error(`GET /todos failed with ${res.status}`)
      return (await res.json()) as Todo[]
    },
  }
}
```

## 2. Write a controller

A controller is a function from `ctx` to an object. The object it returns is its public API, and anything it does not return stays private to its closure.

```ts file=todos.ts
// todos.ts
import { computed, createQuery, defineController, defineQuery, signal } from '@kontsedal/olas-core'

// A query is defined once, at module scope, and shared by every subscriber in a root.
export const todosQuery = defineQuery({
  id: 'todos/list',
  key: () => [],
  // `signal` here is the fetch's AbortSignal, not the `signal` function imported above.
  fetcher: ({ signal, deps }) => deps.api.listTodos(signal),
  staleTime: 30_000,
})

export const todoList = defineController((ctx) => {
  const todos = createQuery(ctx, todosQuery)
  const showDone = signal(true)

  const visible = computed(() => {
    const all = todos.data.value ?? []
    return showDone.value ? all : all.filter((todo) => !todo.done)
  })
  const remaining = computed(() => (todos.data.value ?? []).filter((todo) => !todo.done).length)

  return {
    todos,
    showDone,
    visible,
    remaining,
    toggleShowDone: () => showDone.update((value) => !value),
  }
})
```

Four primitives appear here, and each one does one job:

| Primitive | What it is |
|---|---|
| `signal(true)` | A typed cell. Read it with `.value`, write it with `.set(...)` or `.update(fn)`. |
| `computed(fn)` | A read-only signal derived from others. It recomputes when a signal it read changes. |
| `defineQuery({ id, key, fetcher })` | A module-scope query definition. The `id` names it in SSR payloads, plugins and devtools, so write it by hand. |
| `createQuery(ctx, query)` | A subscription that belongs to this controller. It returns an `AsyncState` with `data`, `error`, `isLoading` and seven more signals. |

The fetcher receives `{ signal, deps }`. The cache aborts `signal` when it drops the fetch, for example on a key change or a `cancel()`, and `deps` is the object the root was given. `createQuery` takes `ctx` as its first argument, which ties the subscription to this controller: when the controller is disposed, the subscription goes with it.

The factory is synchronous. It sets things up and returns, and the query fetches in the background.

## 3. Create the root

A root instantiates the top controller once, near the app's entry point. It is where `deps` are supplied and where the query engine is switched on.

```ts file=root.ts
// root.ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import { createHttpApi } from './api'
import { todoList } from './todos'

export const root = createRoot(todoList, {
  deps: { api: createHttpApi('/api') },
  queries: queryEngine(),
})

// Register the root's type once, so `useRoot()` needs no type argument.
declare module '@kontsedal/olas-react' {
  interface Register {
    root: typeof root
  }
}
```

`queries: queryEngine()` gives this root its own query cache. A root without an engine has no cache, and `createQuery` throws an error that names the fix. The engine is opt-in so that an app with no queries does not ship the cache code.

`createRoot` returns a handle. The controller's API is on `root.api`, and the root's own controls sit beside it: `dispose`, `suspend`, `resume`, `waitForIdle`, `dehydrate`, `hydrate`, `bindQuery`, `inject` and `debug`. [Concepts](/guide/concepts#the-root-handle) explains why the two are kept apart.

## 4. Render it

### React

`OlasProvider` puts the root in React context. The app creates the root and owns its lifetime, so React does not construct or dispose the controller.

```tsx
// main.tsx
import { OlasProvider } from '@kontsedal/olas-react'
import { createRoot as createReactRoot } from 'react-dom/client'
import { App } from './App'
import { root } from './root'

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app element')

createReactRoot(container).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

```tsx file=App.tsx
// App.tsx
import { useQuery, useRoot, useValue } from '@kontsedal/olas-react'

export function App() {
  const api = useRoot()
  const { isLoading, error } = useQuery(api.todos)
  const visible = useValue(api.visible)
  const remaining = useValue(api.remaining)
  const showDone = useValue(api.showDone)

  if (isLoading) return <p>Loading…</p>
  if (error) return <p role="alert">Could not load the list.</p>
  return (
    <section>
      <label>
        <input type="checkbox" checked={showDone} onChange={api.toggleShowDone} />
        Show done
      </label>
      <ul>
        {visible.map((todo) => (
          <li key={todo.id}>{todo.title}</li>
        ))}
      </ul>
      <p>{remaining} left</p>
    </section>
  )
}
```

- `useRoot()` returns `root.api`, typed through the `Register` augmentation in `root.ts`.
- `useValue(signal)` subscribes the component to one signal and returns its current value.
- `useQuery(state)` returns every field of the query state as a plain value. The component re-renders only when a field it read changes, so this one ignores a background refetch that flips `isFetching`.

The component holds no state of its own and makes no decision the controller could make. That is the whole contract between the two trees.

### Vue

The Vue adapter installs the root as a plugin and turns signals into read-only refs.

```ts
// main.ts
import { olasPlugin } from '@kontsedal/olas-vue'
import { createApp } from 'vue'
import App from './App.vue'
import { root } from './root'

createApp(App).use(olasPlugin(root)).mount('#app')

declare module '@kontsedal/olas-vue' {
  interface Register {
    root: typeof root
  }
}
```

```vue
<!-- App.vue -->
<script setup lang="ts">
import { useQuery, useRoot, useValue } from '@kontsedal/olas-vue'

const api = useRoot()
const { isLoading, error } = useQuery(api.todos)
const visible = useValue(api.visible)
const remaining = useValue(api.remaining)
</script>

<template>
  <p v-if="isLoading">Loading…</p>
  <p v-else-if="error" role="alert">Could not load the list.</p>
  <section v-else>
    <ul>
      <li v-for="todo in visible" :key="todo.id">{{ todo.title }}</li>
    </ul>
    <p>{{ remaining }} left</p>
  </section>
</template>
```

The [Vue adapter page](/adapters/vue) covers `useField`, `useMutation` and how the refs behave.

### Svelte

An Olas signal already satisfies Svelte's store contract, so `$visible` works on a `computed` with no wrapper. The adapter adds the root context and one store over each multi-signal object, such as a query.

```svelte
<!-- App.svelte -->
<script lang="ts">
  import { setRoot } from '@kontsedal/olas-svelte'
  import TodoList from './TodoList.svelte'
  import { root } from './root'

  setRoot(root)
</script>

<TodoList />
```

```svelte
<!-- TodoList.svelte -->
<script lang="ts">
  import { getRoot, queryStore } from '@kontsedal/olas-svelte'

  const api = getRoot()
  const todos = queryStore(api.todos)
  const { visible, remaining } = api
</script>

{#if $todos.isLoading}
  <p>Loading…</p>
{:else if $todos.error}
  <p role="alert">Could not load the list.</p>
{:else}
  <ul>
    {#each $visible as todo (todo.id)}<li>{todo.title}</li>{/each}
  </ul>
  <p>{$remaining} left</p>
{/if}
```

`getRoot()` is typed the same way as React's `useRoot()`, through a `Register` augmentation in `@kontsedal/olas-svelte`. The [Svelte adapter page](/adapters/svelte) has the rest.

## 5. Test the controller

The controller is plain TypeScript, so its test is a plain unit test. `createTestController` builds an isolated root around one controller, with a live query engine, and returns the same handle `createRoot` does.

```ts file=todos.test.ts
// todos.test.ts
import { createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import type { TodoApi } from './api'
import { todoList } from './todos'

const fakeApi: TodoApi = {
  listTodos: async () => [
    { id: '1', title: 'Write the docs', done: true },
    { id: '2', title: 'Ship 1.0', done: false },
  ],
}

test('hides done todos when asked', async () => {
  const root = createTestController(todoList, { deps: { api: fakeApi } })
  await root.waitForIdle()

  expect(root.api.remaining.value).toBe(1)
  expect(root.api.visible.value).toHaveLength(2)

  root.api.toggleShowDone()
  expect(root.api.visible.value.map((todo) => todo.title)).toEqual(['Ship 1.0'])

  root.dispose()
})
```

The test swaps the service through `deps`, so it needs no module mocking. `root.waitForIdle()` resolves once no fetch is in flight, and every assertion after it reads a signal synchronously. There is no render, no jsdom and no `act`.

`@kontsedal/olas-core/testing` is a separate entry point, so test helpers stay out of the main one and an import of them in production code is easy to find. [Testing](/guide/testing) covers mocked fetches, mutations, forms and component tests.

## Where to go next

- [Concepts](/guide/concepts): the model behind this page. It covers the controller tree, lifetimes, `ctx`, deps, scopes and the per-root query engine.
- [Queries](/guide/queries): keys, stale time, invalidation, dependent queries and infinite queries.
- [Mutations](/guide/mutations): writes with optimistic updates, rollback and concurrency modes.
- [Forms](/guide/forms): fields, forms, field arrays, validators and submission.
- [Testing](/guide/testing): `createTestController`, `mockFetchPlugin`, the plugin recorder and view-test fakes.
- The adapters: [React](/adapters/react), [Vue](/adapters/vue) and [Svelte](/adapters/svelte).
- [Recipes](/guide/recipes): composables for debounced search, pagination, inline editing and realtime patches.
- The [API reference](/reference/olas-core) for every signature, starting from [`createRoot`](/reference/olas-core.createroot) and [`defineQuery`](/reference/olas-core.definequery).

The [example apps](https://github.com/Kontsedal/olas/tree/main/examples) are small, complete applications. `vue-tasks` is the closest to this page: one controller with a query, an optimistic toggle and a validated form, plus its controller tests.
