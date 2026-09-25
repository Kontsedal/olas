# Mutations

A mutation is a write with its state as signals. It gives the button `isPending`, `status` and `error`, and it gives repeated clicks a concurrency rule. An optimistic update rolls itself back on failure, and `detached` answers "what happens if the screen closes mid-request". The controller owns it, so a test drives it without a renderer.

The contract is SPEC [§6](https://github.com/Kontsedal/olas/blob/main/SPEC.md#6-mutations). Full signatures are in the [API reference](/reference/olas-core.createmutation).

## The model

A mutation has two halves:

- **The write and its policy.** `mutate(vars, { signal, deps })`, plus `concurrency`, `retry`, `retryDelay` and `meta`. A module-scope `defineMutation` holds this half and requires an `id`.
- **The lifecycle hooks.** `onMutate`, `onSuccess`, `onError`, `onSettled` and `detached`. They belong to the controller that runs the mutation, through `createMutation(ctx, def, hooks)`.

An inline `createMutation(ctx, spec)` takes both halves in one object. Each run goes through the same steps:

```text
run(vars) ─► onMutate(vars) ─► mutate(vars, { signal, deps }) ─┬─► onSuccess ─► snapshot finalized ─► onSettled
             optional snapshot     retried per `retry`          └─► onError   ─► snapshot rolled back ─► onSettled
```

A mutation needs a query engine on the root, because its runs count toward the in-flight work that `root.waitForIdle()` reads during SSR.

## Define and run a mutation

The examples on this page share one service, typed through `AmbientDeps`, and one query:

```ts file=api.ts
// api.ts: the app's services, typed once for every mutate function
type Options = { signal: AbortSignal }

export type Todo = { id: string; title: string; done: boolean }

export type Api = {
  listTodos(listId: string, options: Options): Promise<Todo[]>
  toggleTodo(todoId: string, options: Options): Promise<Todo>
  renameList(listId: string, title: string, options: Options): Promise<void>
  saveDraft(text: string, options: Options): Promise<void>
  getLicense(options: Options): Promise<{ active: boolean }>
  activateLicense(key: string, options: Options): Promise<void>
  createOrder(order: { sku: string; idempotencyKey: string }, options: Options): Promise<void>
}

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
  }
}
```

```ts file=queries.ts
import { defineQuery } from '@kontsedal/olas-core'

export const todosQuery = defineQuery({
  id: 'todos/list',
  key: (listId: string) => ['todos', listId],
  fetcher: ({ signal, deps }, listId) => deps.api.listTodos(listId, { signal }),
})
```

Define the write at module scope, then run it from a controller with that controller's hooks:

```ts file=mutations.ts
import { defineMutation } from '@kontsedal/olas-core'

export const toggleTodo = defineMutation({
  id: 'todos/toggle',
  mutate: (todoId: string, { signal, deps }) => deps.api.toggleTodo(todoId, { signal }),
})
```

```ts
import { bindQuery, createMutation, defineController } from '@kontsedal/olas-core'
import { toggleTodo } from './mutations'
import { todosQuery } from './queries'

export const todoList = defineController((ctx, props: { listId: string }) => {
  const todos = bindQuery(ctx, todosQuery)
  const toggle = createMutation(ctx, toggleTodo, {
    onSuccess: () => todos.invalidate(props.listId),
  })
  return { toggle } // toggle.run('t1') returns Promise<Todo>
})
```

`defineMutation` registers the definition by `id` in a process-wide registry. A plugin can then run it with no controller present, which is how the mutation queue replays a write after a reload (§6). For that reason `mutate` must not close over controller state. It reaches services through `deps`, which is the root's on a replay.

A [`Mutation<V, R>`](/reference/olas-core.mutation) exposes:

| Member | Meaning |
|---|---|
| `run(vars)` | Starts a run and returns its promise. A mutation whose `V` is `void` takes `run()`. |
| `isPending` | `true` while any run is in flight. |
| `status` | The latest run's outcome: `'idle'`, `'pending'`, `'success'` or `'error'`. |
| `data`, `error`, `lastVariables` | The latest result, failure and variables. |
| `reset()` | Aborts every run in flight, then clears back to `'idle'`. |
| `dispose()` | Tears the mutation down. The owning controller calls it. |

A `void` mutation still reports `status: 'success'` after it resolves, because `status` tracks the run and not `data`.

### Inline specs

For a write that only one controller runs and that no plugin replays, pass the whole spec inline:

<!-- snippet-prelude
import { createMutation, defineController } from '@kontsedal/olas-core'
-->
```ts
export const listHeader = defineController((ctx, props: { listId: string }) => {
  const rename = createMutation(ctx, {
    id: 'lists/rename', // optional inline; it labels devtools and error contexts
    mutate: (title: string, { signal, deps }) => deps.api.renameList(props.listId, title, { signal }),
  })
  return { rename }
})
```

An inline `mutate` may close over the controller, as this one closes over `props`, because nothing replays it.

## Concurrency

`concurrency` decides what a second `run()` does while the first is in flight (§6.1):

| Mode | A new `run()` while one is in flight | Use it for |
|---|---|---|
| `'parallel'` (default) | Runs independently. `isPending` is `true` while any run is in flight. | Distinct writes: save this item, delete that one. |
| `'latest-wins'` | Aborts the previous run through its `AbortSignal`. | Typeahead and debounced writes, where only the last value matters. |
| `'serial'` | Queues, and runs one at a time in order. | Writes whose order matters and none of which may be dropped. |

A superseded `latest-wins` run rejects with an `AbortError`. `isAbortError(err)` tells it apart from a real failure:

```ts
import { createMutation, defineController, isAbortError } from '@kontsedal/olas-core'

export const draftEditor = defineController((ctx) => {
  const save = createMutation(ctx, {
    id: 'drafts/save',
    concurrency: 'latest-wins',
    mutate: (text: string, { signal, deps }) => deps.api.saveDraft(text, { signal }),
  })
  const edit = async (text: string) => {
    try {
      await save.run(text)
    } catch (err) {
      if (isAbortError(err)) return // a newer edit took over
      throw err
    }
  }
  return { save, edit }
})
```

A superseded run fires neither `onError` nor `onSettled`, and it leaves `error` and `status` to the run that replaced it. Put cleanup that must run on supersede in a `try`/`finally` inside `mutate`. `isAbortError` also matches the abort shapes from axios, msw and hand-thrown errors named `'AbortError'`.

## Optimistic updates

An optimistic update shows the result before the server confirms it. The shape is three steps in `onMutate`:

```ts
import { bindQuery, createMutation, defineController } from '@kontsedal/olas-core'
import { toggleTodo } from './mutations'
import { todosQuery } from './queries'

export const board = defineController((ctx, props: { listId: string }) => {
  const todos = bindQuery(ctx, todosQuery)
  const toggle = createMutation(ctx, toggleTodo, {
    onMutate: (todoId) => {
      // 1. Cancel first, so a fetch in flight cannot land over the guess.
      todos.cancel(props.listId)
      // 2. Patch the cache, and 3. return the snapshot for the runner to settle.
      return todos.setData(props.listId, (prev = []) =>
        prev.map((t) => (t.id === todoId ? { ...t, done: !t.done } : t)),
      )
    },
    // Reconcile the guess with the server's record either way.
    onSettled: () => todos.invalidate(props.listId),
  })
  return { toggle }
})
```

- **The runner settles the snapshot.** It finalizes the snapshot when `mutate` succeeds. It rolls the snapshot back when `mutate` fails, after `onError` has run, and `onError` receives the snapshot as its third argument. Both calls are idempotent, so an `onError` that rolls back by hand does no harm.
- **Cancel even when nothing invalidates the query.** A stale entry refetches when a subscriber acquires it and after a `resume()`. A response already in flight when you patch lands over the patch unless you cancel first (§5.5). One that a live patch holds back runs after the snapshot settles (§5.9). The [no-invalidator pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/no-invalidator-still-refetches.md) describes the downstream bug.
- **The entry reports the pending guess.** The query's `hasPendingMutations` signal is `true` while a `setData` snapshot on the entry is unsettled. Use it to render "saving…" on one record without a `pending` flag in the data.
- **`onMutate` is synchronous.** It returns a `Snapshot` or nothing. If it throws, the run fails with that error, `onError` and `onSettled` fire, and `mutate` does not run.

`setData` is only for this optimistic half of a mutation. A write with no mutation to settle it, such as a server push, uses `write` or `replace` ([Queries](/guide/queries#read-and-write-the-cache-directly)). A stray `setData` leaves a live snapshot behind, and `hasPendingMutations` stays `true`.

Two rules in [`@kontsedal/olas-eslint-plugin`](/packages/eslint-plugin) check this shape. [`olas/optimistic-returns-snapshot`](https://github.com/Kontsedal/olas/blob/main/packages/eslint-plugin/docs/optimistic-returns-snapshot.md) reports a snapshot that nothing settles. [`olas/cancel-before-optimistic`](https://github.com/Kontsedal/olas/blob/main/packages/eslint-plugin/docs/cancel-before-optimistic.md) reports an optimistic `setData` in `onMutate` with no `cancel` on the same query before it.

### Several guesses at once

Each snapshot captures the value at the moment its `setData` ran, and live snapshots stack in the order they were applied (§6.4). Rolling back the top one restores its captured value. Rolling back one lower down leaves the screen alone and threads its baseline down to the layer below. Once every layer has rolled back, in any order, the data is back at the pre-mutation value.

- **`latest-wins` rolls back first.** The runner rolls the superseded run's snapshot back before it calls the new run's `onMutate`, so the new guess does not stack on the obsolete one. The [rollback-order pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/latest-wins-rollback-order.md) shows what the other order breaks.
- **A successful fetch rebases live snapshots.** When a fetch lands while guesses are live, each snapshot's baseline becomes the fresh server value. A later rollback then restores server truth.
- **Conflicting writes want `serial`.** The stack restores baselines and does not replay updaters, so two mutations that write one field should queue.

## Retry

`retry` and `retryDelay` take the shapes they take on a query: a count or `(attempt, error) => boolean`, and a delay in ms or `(attempt) => number`. The defaults are no retry and a constant 1000 ms delay. A retried run is one run: `onMutate` runs once, the hooks fire once, and plugins hear one start. An abort ends the retry chain, and the runner does not retry an `AbortError`.

## Cancellation and dispose

A run's `signal` aborts on three triggers (§6.2):

- The owning controller is disposed, unless the mutation is `detached`.
- `reset()` is called.
- A `latest-wins` run supersedes it.

`reset()` cancels. It aborts every run in flight and rejects queued `serial` runs with an `AbortError`. A react-query `reset()` lets the request finish, so a mechanical port changes whether the write lands.

**`run()` after dispose rejects with [`MutationDisposedError`](/reference/olas-core.mutationdisposederror), and `mutate` never runs.** It is deliberately not an `AbortError`. An abort filter exists to drop cancellations the app chose, and this error reports a write the app asked for and did not get. It carries `mutationId` and `controllerPath`.

<!-- snippet-prelude
import type { Mutation } from '@kontsedal/olas-core'
declare const toggle: Mutation<string, unknown>
declare const toast: { error(err: unknown): void }
-->
```ts
import { isAbortError, MutationDisposedError } from '@kontsedal/olas-core'

await toggle.run('t1').catch((err) => {
  if (err instanceof MutationDisposedError) {
    // The write never ran. Own the mutation higher up, or mark it `detached`.
  } else if (!isAbortError(err)) {
    toast.error(err)
  }
})
```

Two edge cases complete the picture:

- **A run that already finished is finalized, not rolled back.** When `mutate` resolves and a dispose or `reset()` lands before the run continues, the work has happened. The runner finalizes the snapshot instead of rolling it back, plugins hear `'success'`, and the caller's promise still rejects with an `AbortError`. `onSuccess` does not run on that path, so its invalidation does not fire.
- **A `mutate` that ignores its signal still lets the caller go.** The runner races the `mutate` promise against the signal, so an aborted run settles at once for the caller. The [raceAbort pitfall](https://github.com/Kontsedal/olas/blob/main/.wiki/pitfalls/raceabort-for-misbehaving-mutate.md) records why. The request itself runs on unless `mutate` passes `signal` to its I/O. [`olas/honor-abort-signal`](https://github.com/Kontsedal/olas/blob/main/packages/eslint-plugin/docs/honor-abort-signal.md), in the lint plugin's `strict` config, reports a `mutate` that does not.

## Detached runs

Dispose is right for a read the closing screen no longer wants, and wrong for a write the user already asked for. `detached: true` stops dispose from cancelling (§6.5):

```ts
import { createMutation, defineController, defineQuery } from '@kontsedal/olas-core'

export const licenseQuery = defineQuery({
  id: 'license',
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.getLicense({ signal }),
})

export const licenseDialog = defineController((ctx) => {
  const activate = createMutation(ctx, {
    id: 'license/activate',
    detached: true,
    mutate: (key: string, { signal, deps }) => deps.api.activateLicense(key, { signal }),
    onSuccess: () => licenseQuery.invalidate(),
  })
  return { activate }
})
```

With `detached: true`, runs in flight finish, queued `serial` runs drain, `run()` keeps working after dispose, and `onSuccess`, `onError` and `onSettled` still fire. `reset()` and a `latest-wins` supersede still cancel, because both say "drop this one". The hooks run after the controller is torn down, so keep them to client-level work such as `query.invalidate()`, a toast or a logger. If the whole root is gone, the run still completes and its cache writes do nothing.

## In a React component

`useMutation(mutation)` from `@kontsedal/olas-react` reads the signals and hands you two triggers:

```tsx
import type { Mutation } from '@kontsedal/olas-core'
import { useMutation } from '@kontsedal/olas-react'

export function ToggleButton(props: { toggle: Mutation<string, unknown>; todoId: string }) {
  const { mutate, isPending, isError } = useMutation(props.toggle)
  return (
    <button type="button" disabled={isPending} onClick={() => mutate(props.todoId)}>
      {isError ? 'Retry' : 'Toggle'}
    </button>
  )
}
```

`mutate(vars)` returns nothing, and a failure lands on `error` and `status`, so an event handler needs no `catch`. `run(vars)` returns the run's promise for a caller that needs the result, and that caller owns the rejection. The hook's callbacks fire from the React layer and skip aborted runs, so cache work belongs in the mutation's own hooks. See [the React adapter](/adapters/react#usemutation-mutate-and-run), and the [Vue](/adapters/vue) and [Svelte](/adapters/svelte) equivalents.

## Surviving a reload

`@kontsedal/olas-mutation-queue` replays a write that a reload or a crash interrupted. Opt a definition in with `meta: { persist: true }`, which the package types through `MutationMeta`:

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
import type { Api } from './api'
declare const app: ControllerDef<void, unknown>
declare const api: Api
-->
```ts
import { createRoot, defineMutation, queryEngine } from '@kontsedal/olas-core'
import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

export const placeOrder = defineMutation({
  id: 'orders/place',
  mutate: (order: { sku: string; idempotencyKey: string }, { signal, deps }) =>
    deps.api.createOrder(order, { signal }),
  meta: { persist: true },
})

const root = createRoot(app, {
  deps: { api },
  queries: queryEngine(),
  plugins: [mutationQueuePlugin({ storage: localStorageAdapter(), keyPrefix: 'shop/mutations/v1' })],
})
```

The plugin stores each run before the request goes out and deletes it on success. It replays pending runs at startup, on reconnect and on `replayNow()`. Delivery is at least once, so send an `idempotencyKey` and have the server dedupe on it. Only a `defineMutation` definition can persist, because a replay looks the write up by `id`. The [mutation-queue page](/packages/mutation-queue) and the [persisted-mutations recipe](/guide/recipes#persisted-mutations-—-survive-reloads-with-kontsedal-olas-mutation-queue) have the full contract.

## Sharp edges

- **Put cache work in the mutation's hooks.** `useMutation`'s callbacks fire only for runs started through that hook's `mutate` or `run`, and they skip aborted runs.
- **A detached hook runs after dispose.** It must not touch the controller's signals, fields or children.
- **`status` is written by every run.** Each run sets it when it starts and when it settles. In `parallel` mode it can read `'success'` while `isPending` is still `true`.
- **`onSuccess` is skipped on the late-abort path.** A run whose work finished moments before its abort is finalized, and no invalidation fires. `detached: true` avoids the gap for writes the user was promised.

## See also

- Reference: [`defineMutation`](/reference/olas-core.definemutation), [`createMutation`](/reference/olas-core.createmutation), [`MutationSpec`](/reference/olas-core.mutationspec), [`MutationHooks`](/reference/olas-core.mutationhooks), [`Mutation`](/reference/olas-core.mutation), [`Snapshot`](/reference/olas-core.snapshot) and [`useMutation`](/reference/olas-react.usemutation).
- [Recipes](/guide/recipes#optimistic-update-—-cancel-patch-return-the-snapshot): the optimistic update and a validate-then-mutate submit.
- [Queries](/guide/queries) for the cache these writes update, and [Forms](/guide/forms#submit) for submitting through a mutation.
