# What is Olas?

Olas is a TypeScript library for the part of an app that is not rendering: fetching, state, writes, validation and the rules that tie them together. It puts that logic in controllers, and your UI framework draws what the controllers expose.

## The problem

Most apps keep their logic in one of three places, and each one has a cost.

- **Inside components.** It is easy at first. At scale the same data is fetched twice, effects tangle with renders, and a test boots a renderer to check one rule.
- **In one global store.** It scales, but everything is global, nothing says who owns a piece of state, and state lives until the page closes.
- **In hooks at the top of each page.** Two pages that mount the same hook fetch twice instead of sharing, and the lifetime is whatever the framework decides.

## The idea: two trees

<TwoTrees />

Olas adds a second tree beside the component tree. Each node is a controller, and each controller owns one feature: its signals, its queries, its mutations, its forms and its child controllers. When a controller is disposed, everything it created goes with it.

The only link between the trees is one arrow. A component reads a controller's signals and calls its methods, and a controller imports no component. That arrow gives three things:

- **Logic runs without a renderer.** A test builds a controller in Node, calls its methods and reads its signals.
- **Lifetimes are explicit.** A feature's state is created with its controller and destroyed with it.
- **The view layer is replaceable.** The core imports no framework. The React, Vue and Svelte adapters are thin layers over it.

## A controller

A controller is a plain function from `ctx` to an object. This one loads a todo list and counts what is left:

```ts
import {
  computed,
  createQuery,
  defineController,
  defineQuery,
} from '@kontsedal/olas-core'

type Todo = { id: string; title: string; done: boolean }

const todosQuery = defineQuery({
  id: 'todos/list',
  key: () => [],
  fetcher: ({ signal }) =>
    fetch('/api/todos', { signal }).then((res) => res.json() as Promise<Todo[]>),
})

export const todoList = defineController((ctx) => {
  const todos = createQuery(ctx, todosQuery)
  const remaining = computed(() => (todos.data.value ?? []).filter((t) => !t.done).length)

  return { todos, remaining }
})
```

- `defineQuery` describes the request once, at module scope. Two controllers that subscribe to it share one cache entry and one fetch.
- `createQuery(ctx, …)` ties the subscription to this controller, so the subscription ends when the controller does. The data stays cached for five minutes in case the user comes back.
- `computed` derives `remaining` from the query's data. It updates when the data changes, and a component that shows it re-renders only then.

[Getting started](/guide/getting-started) builds this controller into a working app, with a view and a test.

## When it fits

Olas is built for apps with real logic on the client:

- dashboards, editors and admin tools, where one piece of data shows on several screens;
- apps where tests of the business rules should not render anything;
- offline-capable apps, with optimistic writes, a durable mutation queue and a persisted cache;
- teams that share logic across React, Vue and Svelte, or expect to change view layers.

It is less useful for a mostly static site, or for a page that renders server data with no client logic. A library that fetches is enough there.

If you already use TanStack Query, Redux Toolkit, Zustand, MobX, Effector or XState, the README has [short, honest comparisons](https://github.com/Kontsedal/olas#how-it-compares). None of them is a reason to leave a tool that works for you.

## Next steps

- [Getting started](/guide/getting-started) builds one feature end to end, in React, Vue or Svelte.
- [Concepts](/guide/concepts) explains the model: the controller tree, lifetimes, `ctx`, deps and scopes.
- The [example apps](https://github.com/Kontsedal/olas/tree/main/examples) are small, complete applications: a kanban board, a stock ticker, a virtualized table, a streaming SSR reader and a Vue task list.
