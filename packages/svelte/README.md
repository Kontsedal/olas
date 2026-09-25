# @kontsedal/olas-svelte

The Svelte adapter for [Olas](../..). An Olas `ReadSignal` already satisfies Svelte's store contract: its `subscribe(run)` calls `run` with the current value at once and on every change, and returns the unsubscribe. So `$count` works on a signal with no wrapper. This package adds the root context and one store per multi-signal object: a query, an infinite query, a field and a mutation.

## Install

```bash
pnpm add @kontsedal/olas-svelte @kontsedal/olas-core @preact/signals-core svelte
```

`svelte >= 4` is a peer dependency. The tests run on Svelte 5, and the examples below use Svelte 5 syntax: on Svelte 4, write `on:click` where they write `onclick`.

## Example

```ts
// root.ts: the controller knows nothing about Svelte
import { createRoot, defineController, signal } from '@kontsedal/olas-core'

export const root = createRoot(
  defineController(() => {
    const count = signal(0)
    return { count, inc: () => count.set(count.peek() + 1) }
  }),
  { deps: {} },
)

// Register the root's type once, so `getRoot()` needs no type argument.
declare module '@kontsedal/olas-svelte' {
  interface Register {
    root: typeof root
  }
}
```

```svelte
<!-- App.svelte: provide the root to the tree below -->
<script lang="ts">
  import { setRoot } from '@kontsedal/olas-svelte'
  import Counter from './Counter.svelte'
  import { root } from './root'

  setRoot(root)
</script>

<Counter />
```

```svelte
<!-- Counter.svelte: a signal is a store -->
<script lang="ts">
  import { getRoot } from '@kontsedal/olas-svelte'

  const api = getRoot()
  const count = api.count
</script>

<button onclick={api.inc}>{$count}</button>
```

## API

| Export | Purpose |
|---|---|
| `setRoot(root)` | Provide a root to the component tree below. Call it while a component initializes. |
| `getRoot<Api>()` | The nearest root's api. `Register` types it; a type argument is an unchecked cast. Throws when no ancestor called `setRoot`. |
| `queryStore(subscription)` | One store over a query's state: `$q.data`, `$q.isLoading` and the rest update together. Carries `refetch`, `reset` and `cancel`. |
| `infiniteQueryStore(subscription)` | The same, plus `pages`, `flat` and the paging flags, and `fetchNextPage` / `fetchPreviousPage`. |
| `fieldStore(field)` | One store over a field's value and validation state, plus the field's actions. Binds as `bind:value={$state.value}`. |
| `mutationStore(mutation)` | One store over a mutation's state, plus `mutate`, `run` and `reset`. |

`Register` and `RegisteredApi` type `getRoot()`. Each store's type is exported: `QueryStore`, `InfiniteQueryStore`, `FieldStore` and `MutationStore`, with the matching `…State`.

## How it behaves

- **A field binds as it is.** `Field` has `set`, which makes it a writable store, so `<input bind:value={$name} />` writes through `field.set`. Reach for `fieldStore` when the input also shows errors, and bind its member: `<input bind:value={$state.value} />`. Svelte writes a member binding by assigning the member on the value it holds and passing that whole value to `set`. `fieldStore` hands each subscriber its own copy of the state, and its `set` writes a copy's `value` to the field.
- **Bind a form's leaf fields, not members of `$form`.** A `Form` and a `FieldArray` have `set` too, so `bind:value={$form.name}` compiles. Svelte then assigns `name` on the form's current value object in place before it calls `form.set`. The form ends right, but a value object you held earlier, such as a last-saved snapshot, changes under you. Bind the field: `<input bind:value={$name} />` with `const name = form.fields.name`.
- **One store per object, one update per change.** `queryStore` derives its value from every signal on the query, so a `batch` of writes reaches the component once.
- **Svelte manages the subscriptions.** A `$store` read subscribes when the component mounts and unsubscribes when it is destroyed.
- **`mutate` is fire-and-forget.** It returns nothing, and a failure lands on `$save.error` and `$save.status`. The adapter catches the rejection, so it does not become an unhandled one. `run` returns the promise, and the caller owns its rejection.

## Testing

A controller tests without Svelte, through `createTestController` from `@kontsedal/olas-core/testing`. Component tests need the Svelte compiler plugin and the `browser` resolve condition, or `svelte` resolves to its server build and `mount` throws. The root `vitest.config.ts` runs them as their own project for that reason. `packages/integration/tests/adapter-parity/` runs the same scenarios through this adapter, React, `preact/compat` and Vue, and asserts the same DOM.
