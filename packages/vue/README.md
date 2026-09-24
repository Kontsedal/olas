# @kontsedal/olas-vue

The Vue 3 adapter for [Olas](../..). It turns Olas signals into Vue refs. The root is built outside Vue, once, and `app.use(olasPlugin(root))` hands it to every component. Vue does not own a controller's lifetime, so a component that unmounts drops its subscriptions and nothing else.

## Install

```bash
pnpm add @kontsedal/olas-vue @kontsedal/olas-core @preact/signals-core vue
```

`vue >= 3.4` is a peer dependency.

## Example

```ts file=counter.ts
// counter.ts: the controller knows nothing about Vue
import { defineController, signal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return { count, inc: () => count.set(count.peek() + 1) }
})
```

```ts
// main.ts: build the root once, then install it
import { createRoot } from '@kontsedal/olas-core'
import { olasPlugin } from '@kontsedal/olas-vue'
import { createApp } from 'vue'
import App from './App.vue'
import { counter } from './counter'

export const root = createRoot(counter, { deps: {} })
createApp(App).use(olasPlugin(root)).mount('#app')

// Register the root's type once, so `useRoot()` needs no type argument.
declare module '@kontsedal/olas-vue' {
  interface Register {
    root: typeof root
  }
}
```

```vue
<!-- App.vue: components read signals as refs -->
<script setup lang="ts">
import { useRoot, useValue } from '@kontsedal/olas-vue'

const api = useRoot()
const count = useValue(api.count)
</script>

<template>
  <button @click="api.inc">{{ count }}</button>
</template>
```

## API

| Export | Purpose |
|---|---|
| `olasPlugin(root)` | The Vue plugin for `app.use`. It provides the root to the whole app. |
| `useRoot<Api>()` | The root's api. `Register` types it; a type argument is an unchecked cast. Throws when no plugin provided a root. |
| `useValue(signal, { isEqual? })` | A read-only ref over any `ReadSignal`: a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`. |
| `useQuery(subscription)` | One ref per `AsyncState` signal (`data`, `status`, `isLoading`, `isFetching` and the rest), plus `refetch`, `reset` and `cancel`. |
| `useInfiniteQuery(subscription)` | `useQuery`'s refs, plus `pages`, `flat`, the paging flags, `fetchNextPage` and `fetchPreviousPage`. |
| `useField(field)` | A writable `value` ref for `v-model`, refs for the validation state, and the field's actions. |
| `useMutation(mutation)` | Refs for `data`, `error`, `status`, `isPending` and `lastVariables`, plus `mutate`, `run` and `reset`. |

`Register` and `RegisteredApi` type `useRoot()`. Each hook's return type is exported as `Use…Return`, and `Refs<T>` is the shape they return their state in.

## How it behaves

- **A read does not lag a write.** A ref's getter reads the signal's current value, so code that writes a signal and then reads the ref sees the new value.
- **Vue tracks each ref on its own.** A template that reads `data` does not re-render when `isFetching` flips, because each field is a separate ref.
- **Subscriptions end with the component.** The adapter ties each one to the current effect scope with `onScopeDispose`. Called outside any scope, a hook still returns a working ref, but nothing ends its subscription. A development build warns about it once per hook, naming the hook. To use a hook outside a component, call it inside `effectScope().run()` and call `stop()` on the scope when you are done.
- **`mutate` is fire-and-forget.** It returns nothing, and a failure lands on `error` and `status`. The adapter catches the rejection, so it does not become an unhandled one. `run` returns the promise, and the caller owns its rejection.
- **The refs are read-only.** `useValue` ignores an assignment. Write through the signal, or through `useField`'s `value`, which calls `field.set`.

## Testing

A controller tests without Vue, through `createTestController` from `@kontsedal/olas-core/testing`. `examples/vue-tasks` shows both halves: controller tests in plain Node, and one mounted run of the real app. `packages/integration/tests/adapter-parity/` runs the same scenarios through this adapter, React, `preact/compat` and Svelte, and asserts the same DOM.
