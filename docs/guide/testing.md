# Testing

A controller is a function, so its test is a unit test. The test builds the controller with fake services, calls its methods and reads its signals. It needs no renderer, no jsdom and no `act`, and it runs in plain Node (§17).

This page covers the helpers in `@kontsedal/olas-core/testing` and the patterns the [example apps](https://github.com/Kontsedal/olas/tree/main/examples) use. It tests queries against a live engine and against mocked fetches, then mutations, forms, plugin events and components.

## The testing entry point

| Export | Use it to |
|---|---|
| `createTestController(def, options)` | Build an isolated root around one controller. |
| `mockFetchPlugin(handlers, options?)` | Answer query fetches by query `id`, without running their fetchers. |
| `createPluginRecorder()` | Record every plugin event a root emits. |
| `fakeField(initial, overrides?)` | Stand in for a `Field` in a component test. |
| `fakeAsyncState(overrides?)` | Stand in for a query's `AsyncState` in a component test. |

The helpers sit on their own sub-path, `@kontsedal/olas-core/testing`, rather than the main entry. That keeps them out of an app's production imports, and an import of them in production code is one grep away. [`olas/no-testing-outside-tests`](https://github.com/Kontsedal/olas/blob/main/packages/eslint-plugin/docs/no-testing-outside-tests.md), in the lint plugin's `recommended` config, reports one. The package's `exports` map publishes the sub-path beside the main entry.

## The controller under test

Every example on this page tests one controller: a todo list with a query, an optimistic toggle and a validated add form. It reads its service from `ctx.deps`, so each test decides what that service does.

```ts file=todos.ts
import {
  bindQuery,
  computed,
  createField,
  createForm,
  createMutation,
  createQuery,
  defineController,
  defineQuery,
  maxLength,
  required,
} from '@kontsedal/olas-core'

export type Todo = { id: string; title: string; done: boolean }

export interface TodoApi {
  list(signal: AbortSignal): Promise<Todo[]>
  setDone(id: string, done: boolean, signal: AbortSignal): Promise<void>
  add(title: string, signal: AbortSignal): Promise<Todo>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: TodoApi
  }
}

export const todosQuery = defineQuery({
  id: 'todos/list',
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.list(signal),
  staleTime: 30_000,
})

export const todoList = defineController((ctx, props: { owner: string }) => {
  const todos = createQuery(ctx, todosQuery)
  const cache = bindQuery(ctx, todosQuery)
  const remaining = computed(() => (todos.data.value ?? []).filter((t) => !t.done).length)

  // Optimistic: cancel a refetch in flight, then return the snapshot.
  const toggle = createMutation(ctx, {
    id: 'todos/toggle',
    onMutate: ({ id, done }: { id: string; done: boolean }) => {
      cache.cancel()
      return cache.setData((prev) => prev?.map((t) => (t.id === id ? { ...t, done } : t)) ?? [])
    },
    mutate: ({ id, done }, { signal, deps }) => deps.api.setDone(id, done, signal),
  })

  const addForm = createForm(ctx, {
    title: createField<string>(ctx, '', {
      validators: [required('Give it a title'), maxLength(80, 'Keep it under 80 characters')],
    }),
  })
  const add = createMutation(ctx, {
    id: 'todos/add',
    mutate: (title: string, { signal, deps }) => deps.api.add(title, signal),
    onSuccess: (todo) => cache.write((prev) => [...(prev ?? []), todo]),
  })
  const submitAdd = () =>
    addForm.submit(async (value) => {
      await add.run(value.title.trim())
      addForm.reset()
    })

  return { heading: `${props.owner}'s todos`, todos, remaining, toggle, addForm, submitAdd }
})
```

The fake is an ordinary object that implements `TodoApi`, with `vi.fn` so a test can assert on calls. No module mocking is involved, because the controller does not import the real client (§10).

```ts file=fake-api.ts
import { vi } from 'vitest'
import type { Todo, TodoApi } from './todos'

export function createFakeApi(seed: Todo[]) {
  let rows = seed.map((todo) => ({ ...todo }))
  let failNext = false
  const api = {
    list: vi.fn(async () => rows.map((todo) => ({ ...todo }))),
    setDone: vi.fn(async (id: string, done: boolean) => {
      if (failNext) {
        failNext = false
        throw new Error('rejected')
      }
      rows = rows.map((todo) => (todo.id === id ? { ...todo, done } : todo))
    }),
    add: vi.fn(async (title: string) => {
      const todo = { id: String(rows.length + 1), title, done: false }
      rows = [...rows, todo]
      return todo
    }),
  } satisfies TodoApi
  return { api, failNext: () => void (failNext = true) }
}
```

## A first test with `createTestController`

```ts
import { createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { createFakeApi } from './fake-api'
import { todoList } from './todos'

test('loads the list and counts what is left', async () => {
  const { api } = createFakeApi([
    { id: '1', title: 'Write the docs', done: false },
    { id: '2', title: 'Ship 1.0', done: true },
  ])
  const root = createTestController(todoList, { deps: { api }, props: { owner: 'Ada' } })

  expect(root.api.todos.isLoading.value).toBe(true) // the fetch started during construction
  await root.waitForIdle()

  expect(root.api.heading).toBe("Ada's todos")
  expect(root.api.remaining.value).toBe(1)
  expect(api.list).toHaveBeenCalledTimes(1)
  root.dispose()
})
```

`createTestController` returns the same `Root` handle `createRoot` does. The controller's api is on `.api`, beside `waitForIdle`, `dispose`, `bindQuery`, `inject`, `suspend`, `resume`, `dehydrate` and `hydrate`. It takes the options `createRoot` takes, plus `props`, and its `queries` default to a live engine:

| Option | Default | What it does |
|---|---|---|
| `deps` | required | The services the code under test reads. The type is inferred from the value, so a test passes only what it needs. |
| `props` | required when the controller takes props | The controller's props. A root controller takes none, so `createRoot` has no such option. |
| `queries` | a live `queryEngine()` | Pass `queryEngine({ defaults })` to test against root-wide defaults, or `null` for a root with no cache. |
| `plugins` | none | Plugins for this root: `mockFetchPlugin`, the recorder, or the plugin under test. |
| `scopes` | none | `[scope, value]` pairs seeded above the controller. They win over a plugin's value, so a fake can replace a plugin's service. |
| `hydrate` | none | A `DehydratedState` to seed the cache from. |
| `onError` | `console.error` | Receives the errors the root reports, such as a throwing effect or plugin hook. |

The engine defaults to a live one because a test controller exists to exercise behavior, and an opt-in on every test would be noise. Each call builds its own root and its own cache, so two tests do not share an entry.

The rest of the page uses a small helper, the shape the `vue-tasks` example uses:

```ts file=setup.ts
import { createTestController } from '@kontsedal/olas-core/testing'
import { createFakeApi } from './fake-api'
import { todoList } from './todos'

export const seed = [
  { id: '1', title: 'Write the docs', done: false },
  { id: '2', title: 'Ship 1.0', done: true },
]

export function setup() {
  const fake = createFakeApi(seed)
  const root = createTestController(todoList, { deps: { api: fake.api }, props: { owner: 'Ada' } })
  return { ...fake, root, app: root.api }
}
```

## Waiting for async work

`root.waitForIdle()` resolves once no query fetch, no mutation run and no plugin-tracked work is in flight. It repeats the check until nothing moves, so a fetch that settles and starts another is covered. After it resolves, every assertion reads a signal synchronously.

Two other ways to wait, for narrower cases:

- `state.firstValue()` resolves with a query's data at once when it has some. Otherwise it resolves with the first success, or rejects on the first failure.
- A mutation's `run(vars)` returns a promise that settles with that run.

A `createCache` local cache counts toward `waitForIdle()` too. Its entry lives in its controller rather than in the root's query cache, and the root tracks it all the same, with or without a query engine.

Under fake timers, advance the clock before you await `waitForIdle()`, with `await vi.advanceTimersByTimeAsync(ms)`. A retry waiting out its `retryDelay` keeps its fetch in flight until the timer fires. A fetch behind a `debounced` key has not started, so `waitForIdle()` does not see it yet.

## Testing queries

### With a live engine

The default engine runs the real fetcher against the fake deps, as the first test did. Two more patterns cover most query tests.

**Seed the cache** through `root.bindQuery(query)`. Use `replace`, which supersedes the fetch the subscription started during construction. A `write` patches and leaves that fetch alone, so the fetch lands over the seed. `setData` is for optimistic updates: it returns a snapshot that a mutation must settle, and a test that drops it leaves the entry reporting `hasPendingMutations` (§6.4).

```ts
import { expect, test } from 'vitest'
import { setup } from './setup'
import { todosQuery } from './todos'

test('counts a seeded list', async () => {
  const { root, app } = setup()
  root.bindQuery(todosQuery).replace([{ id: '9', title: 'Seeded', done: false }])
  await root.waitForIdle()
  expect(app.remaining.value).toBe(1)
  root.dispose()
})
```

**Test root-wide policy** by passing the engine the app uses: `createTestController(def, { deps, queries: queryEngine({ defaults: { retry: 2 } }) })`. A per-query field still wins over a default.

### With `mockFetchPlugin`

`mockFetchPlugin(handlers)` answers fetches by query `id` without calling the fetchers. It is a `wrapFetch` middleware, so it sits where a real plugin would. Reach for it when a fetcher calls `fetch` directly instead of a service on `deps`, or when a test needs an error or latency the fake does not have.

A handler takes one of three forms:

- `{ data }` resolves with that value.
- `{ error }` rejects with that value.
- A function of the fetch attempt returns the data, or throws. It receives the `FetchContext`: `query`, `key`, `args`, `attempt` and `signal`.

The two object forms take their own `delayMs`. `mockFetchPlugin(handlers, { delayMs })` adds latency to every answer that sets none.

```ts
import { createTestController, mockFetchPlugin } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { seed } from './setup'
import { todoList } from './todos'

test('a failed refetch keeps the last data and reports the error', async () => {
  const mock = mockFetchPlugin({ 'todos/list': { data: seed } })
  const root = createTestController(todoList, {
    deps: {}, // the list fetcher never runs, so it needs no api
    props: { owner: 'Ada' },
    plugins: [mock],
  })
  await root.waitForIdle()
  expect(root.api.remaining.value).toBe(1)

  mock.respond('todos/list', { error: new Error('offline') })
  await root.api.todos.refetch().catch(() => {})

  expect(root.api.todos.status.value).toBe('error')
  expect(root.api.todos.data.value).toHaveLength(2)
  expect(mock.calls.map((call) => call.attempt)).toEqual([0, 0])
  root.dispose()
})
```

- `calls` records every attempt the plugin answered or passed through, retries included, in order.
- `respond(id, handler)` changes an answer mid-test.
- A query with no handler fails its fetch with an error that names the query, so an unmocked request cannot reach the network by accident. `mockFetchPlugin(handlers, { passthrough: true })` lets such a query run its real fetcher instead.
- A delay honors the fetch's `AbortSignal`, so a `cancel()` ends the wait.
- One plugin value serves every root it is installed on, and `calls` collects them all.

## Testing mutations

A mutation test runs the mutation, reads the optimistic state before the first `await`, then awaits the run and reads the settled state. `onMutate` runs synchronously inside `run`, so the guess is in the cache by the time `run` returns its promise.

```ts
import { expect, test } from 'vitest'
import { setup } from './setup'

test('a toggle shows at once, and rolls back when the server refuses', async () => {
  const { root, app, failNext } = setup()
  await root.waitForIdle()

  failNext()
  const run = app.toggle.run({ id: '1', done: true })
  expect(app.remaining.value).toBe(0) // the guess is already in the cache
  expect(app.todos.hasPendingMutations.value).toBe(true)

  await expect(run).rejects.toThrow('rejected')
  expect(app.remaining.value).toBe(1) // rolled back
  expect(app.toggle.error.value).toBeInstanceOf(Error)
  expect(app.todos.hasPendingMutations.value).toBe(false)
  root.dispose()
})
```

The controller has no `onError`, and the rollback still happens: a mutation rolls back the snapshot `onMutate` returned when the run fails, after `onError` if one exists. The same test without `failNext()` checks the success path, where the mutation finalizes the snapshot and `hasPendingMutations` drops to `false`.

Two rejections are worth their own assertions:

- A superseded `latest-wins` run, a `reset()` and a dispose abort the run. Its promise rejects with an `AbortError`, which `isAbortError(err)` matches.
- A `run` called after its controller is disposed rejects with `MutationDisposedError`, and `mutate` is not called. It is not an `AbortError`, because the write the caller asked for did not happen.

## Testing forms

A form test sets fields the way an input would, submits, and switches on the `SubmitResult` that `form.submit` resolves.

```ts
import { expect, test } from 'vitest'
import { setup } from './setup'

test('adding validates first, then writes the server row into the cache', async () => {
  const { api, root, app } = setup()
  await root.waitForIdle()

  expect(await app.submitAdd()).toEqual({ ok: false, reason: 'invalid' })
  expect(app.addForm.fields.title.errors.value).toEqual(['Give it a title'])
  expect(api.add).not.toHaveBeenCalled()

  app.addForm.fields.title.set('  Plan 1.1  ')
  const added = await app.submitAdd()

  expect(added.ok).toBe(true)
  expect(api.add).toHaveBeenCalledWith('Plan 1.1', expect.any(AbortSignal))
  expect(app.todos.data.value?.map((todo) => todo.title)).toContain('Plan 1.1')
  expect(app.addForm.fields.title.value).toBe('') // reset for the next one
  root.dispose()
})
```

- With the default `validateOn: 'change'`, validators run from construction, so `errors` holds a message before anything is touched. A view shows it once `touched` is true, and an `'invalid'` submit marks every field touched.
- The other `ok: false` reasons are `'busy'`, `'disposed'` and `'error'`, which carries the handler's thrown value.
- Write `createField<string>(ctx, '', { validators })` with the type argument. With validators, TypeScript infers `Field<''>` from the empty string ([pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/literal-type-narrowing.md)).

## Asserting plugin behavior with `createPluginRecorder`

`createPluginRecorder()` returns a plugin and the lists it fills. Install `recorder.plugin`, alone or beside the plugin under test. `events` holds every observation event in arrival order, tagged with its hook. `writes`, `invalidations`, `removals` and `mutations` hold one kind each, and `clear()` empties them all.

```ts
import { createPluginRecorder, createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { createFakeApi } from './fake-api'
import { seed } from './setup'
import { todoList } from './todos'

test('a refused toggle writes a guess, then its rollback', async () => {
  const recorder = createPluginRecorder()
  const { api, failNext } = createFakeApi(seed)
  const root = createTestController(todoList, {
    deps: { api },
    props: { owner: 'Ada' },
    plugins: [recorder.plugin],
  })
  await root.waitForIdle()

  failNext()
  await root.api.toggle.run({ id: '1', done: true }).catch(() => {})

  expect(recorder.writes.map((write) => write.source)).toEqual(['fetch', 'optimistic', 'rollback'])
  expect(recorder.mutations.map((event) => event.phase)).toEqual(['start', 'error'])
  root.dispose()
})
```

A write's `source` says what produced it, and its `origin` names the plugin or `bindQuery` origin that made it. That is what a plugin decides on: one that persists or relays the cache skips `'optimistic'` and `'rollback'` writes, and one that mirrors writes skips its own `origin`. To test your own plugin, install it beside the recorder and assert on those two fields. [Writing a plugin](/guide/plugins#testing-a-plugin) has a worked example.

## Component tests with `fakeField` and `fakeAsyncState`

A component that takes a field or a query state as a prop can render against a fake, with no controller behind it (§17.2). The view does not touch the network, so a view test mocks none.

```tsx
// @vitest-environment jsdom
import type { AsyncState, Field } from '@kontsedal/olas-core'
import { fakeAsyncState, fakeField } from '@kontsedal/olas-core/testing'
import { useField, useQuery } from '@kontsedal/olas-react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import type { Todo } from './todos'

function TodoCount(props: { todos: AsyncState<Todo[]> }) {
  const { data, isLoading } = useQuery(props.todos)
  if (isLoading) return <p>Loading…</p>
  return <p>{data?.length ?? 0} todos</p>
}

function TitleInput(props: { field: Field<string> }) {
  const title = useField(props.field)
  return (
    <label>
      Title
      <input value={title.value} onChange={(e) => title.set(e.target.value)} onBlur={title.markTouched} />
      {title.touched && title.errors[0] && <em>{title.errors[0]}</em>}
    </label>
  )
}

afterEach(() => cleanup())

test('renders the loading state', () => {
  render(<TodoCount todos={fakeAsyncState<Todo[]>({ status: 'pending', isLoading: true })} />)
  expect(screen.getByText('Loading…')).toBeTruthy()
})

test('shows the first error once the field is touched', () => {
  const field = fakeField<string>('', { errors: ['Give it a title'], touched: true })
  render(<TitleInput field={field} />)
  expect(screen.getByText('Give it a title')).toBeTruthy()
})
```

- `fakeField(initial, overrides?)` returns a real `Field<T>`. Its `set`, `reset`, `markTouched` and the other methods work, and each one can be overridden, with `vi.fn()` for example. `isValid` follows `errors` and `isValidating` unless you override it.
- `fakeAsyncState(overrides?)` returns a real `AsyncState<T>`. `status` defaults to `'error'` when `error` is given, `'success'` when `data` is, and `'idle'` otherwise. A `'pending'` status reads as fetching, and as loading while there is no data. `isEnabled` defaults to `true`.
- The fake's `firstValue()` behaves as a real subscription's does. It resolves with the data when there is data or the status is `'success'`, even beside an error. Otherwise it rejects with the error in the `'error'` status, and stays pending while nothing has loaded. `refetch()` resolves with the current data.
- Both satisfy the real types, so `useField`, `useQuery` and any component that takes the real thing accept them without a cast.
- A `fakeAsyncState` holds fixed values. Build one per state you want to render.

The React tests need a DOM, hence the `jsdom` environment comment. Testing Library cleans up by itself only when vitest runs with `globals: true`, so this file calls `cleanup` after each test. To test a component against the real controller instead, render it inside `OlasProvider` with a root from `createTestController` or `createRoot`. The kanban example's `subtasks-row.test.tsx` does that.

## Sharp edges

- **Dispose every root.** A root left alive keeps its subscriptions and its cache entries. The module-level query helpers, such as `todosQuery.invalidate()`, also throw as ambiguous while two live roots have used the query, and a disposed root drops out. An `afterEach` that disposes the test's roots enforces this.
- **Two test controllers do not share a cache.** Test deduplication and `gcTime` inside one root, for example with two children, or with `ctx.attach` and its `dispose()`.
- **A mutation `id` is registered process-wide.** `defineMutation` registers its definition by `id`, and a later definition with the same `id` replaces it. A test file that redefines one `id` can drop the registration with `_unregisterMutationById(id)`, also exported from `/testing`.

## Where to go next

- [Writing a plugin](/guide/plugins#testing-a-plugin) tests a plugin with `mockFetchPlugin` and the recorder together.
- The [React adapter](/adapters/react#fakes-for-tests) shows the fakes in a component test, and the [Vue](/adapters/vue#testing) and [Svelte](/adapters/svelte#testing) pages say what their component tests need.
- The example apps' tests are complete suites: [`vue-tasks`](https://github.com/Kontsedal/olas/tree/main/examples/vue-tasks/tests), [`kanban`](https://github.com/Kontsedal/olas/tree/main/examples/kanban/tests) and [`reader-ssr`](https://github.com/Kontsedal/olas/tree/main/examples/reader-ssr/tests).
- [API.md](https://github.com/Kontsedal/olas/blob/main/API.md#olascoretesting) lists every signature on the `/testing` sub-path.
