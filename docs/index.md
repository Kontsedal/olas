---
layout: home
title: Olas
titleTemplate: App logic outside your components
---

<!-- The hero is HomeHero.vue, in .vitepress/theme/components. -->

## One feature in three files

A counter is the smallest thing Olas can build. A full screen, with queries, forms and child controllers, follows the same three steps.

<div class="home-steps">
<div class="home-step">
<div class="home-step-text">

### Write the logic

A controller is a function that returns an object. That object is everything the screen can read and do. Nothing in it imports React, Vue or Svelte.

</div>
<div class="home-step-code">

```ts file=counter.ts
import { computed, defineController, signal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  const double = computed(() => count.value * 2)

  return {
    count,
    double,
    increment: () => count.update((n) => n + 1),
  }
})
```

</div>
</div>
<div class="home-step">
<div class="home-step-text">

### Draw it

`createRoot(counter)` builds the controller once, outside the view. A component reads its signals and calls its methods. The component keeps no state and makes no decision of its own.

</div>
<div class="home-step-code">

<FrameworkPicker />

<ForFramework name="react">

<!-- snippet-prelude
import type { CtrlApi, Root } from '@kontsedal/olas-core'
import type { counter } from './counter'
declare module '@kontsedal/olas-react' {
  interface Register {
    root: Root<CtrlApi<typeof counter>>
  }
}
-->
```tsx
import { useRoot, useValue } from '@kontsedal/olas-react'

export function Counter() {
  const { count, increment } = useRoot()
  return <button onClick={increment}>Clicked {useValue(count)} times</button>
}
```

</ForFramework>
<ForFramework name="vue">

```vue
<script setup lang="ts">
import { useRoot, useValue } from '@kontsedal/olas-vue'

const { count, increment } = useRoot()
const clicks = useValue(count)
</script>

<template>
  <button @click="increment">Clicked {{ clicks }} times</button>
</template>
```

</ForFramework>
<ForFramework name="svelte">

```svelte
<script lang="ts">
  import { getRoot } from '@kontsedal/olas-svelte'

  const { count, increment } = getRoot()
</script>

<button onclick={increment}>Clicked {$count} times</button>
```

</ForFramework>

</div>
</div>
<div class="home-step">
<div class="home-step-text">

### Test it without a renderer

The test calls the controller the way a component would. It runs in Node, with no DOM, no jsdom and no `act`.

</div>
<div class="home-step-code">

```ts
import { createTestController } from '@kontsedal/olas-core/testing'
import { expect, test } from 'vitest'
import { counter } from './counter'

test('counts clicks', () => {
  const { api } = createTestController(counter, { deps: {} })

  api.increment()

  expect(api.count.value).toBe(1)
  expect(api.double.value).toBe(2)
})
```

</div>
</div>
</div>

## What the core does

`@kontsedal/olas-core` is one package with no framework inside it. These are the parts a controller builds with.

<div class="home-features">
<div>

### [Explicit lifetimes](/guide/concepts#lifetimes)

Dispose a controller and everything it created goes with it: children, effects, queries and forms. There is no cleanup to forget.

</div>
<div>

### [Shared queries](/guide/queries)

Two controllers that ask for the same key share one cache entry and one fetch. Stale times, retries, cancellation and pagination are built in.

</div>
<div>

### [Mutations that roll back](/guide/mutations)

Write to the cache before the server answers. A failed write puts the cache back in order, and a concurrency mode decides what a second click does.

</div>
<div>

### [Forms as signals](/guide/forms)

Fields, forms and field arrays, with sync and async validators, server errors and a submit that returns a typed result.

</div>
<div>

### [Server rendering](/guide/ssr)

One root per request, so one user's data cannot reach another's page. Hydrate on the client, or stream each query into the page as it settles.

</div>
<div>

### [Plugins](/guide/plugins)

One contract for behavior that cuts across every query. Cross-tab sync, persistence, entity normalization and the offline queue are plugins on it.

</div>
</div>

## Add only what you need

Every package is optional apart from the core and one adapter. Each one installs on its own.

<div class="home-packages">
<div>

### Frameworks

- [olas-react](/adapters/react) Hooks for React 18 and later, and for Preact
- [olas-vue](/adapters/vue) Signals as read-only refs, for Vue 3.4 and later
- [olas-svelte](/adapters/svelte) Stores for Svelte 4 and 5

### Routing and forms

- [olas-router](/packages/router) Route params and search as signals in controllers
- [olas-zod](/packages/zod) A Zod schema as the shape and validation of a form

</div>
<div>

### Data and sync

- [olas-persist](/packages/persist) Keep signals and the query cache across reloads
- [olas-cross-tab](/packages/cross-tab) Mirror cache writes to every open tab
- [olas-entities](/packages/entities) Update one entity in every query that holds it
- [olas-realtime](/packages/realtime) Patch the cache from WebSocket or SSE events
- [olas-mutation-queue](/packages/mutation-queue) Replay a write that a reload interrupted

### Tools

- [olas-devtools](/packages/devtools) An in-app panel with a timeline of what caused what
- [olas-eslint-plugin](/packages/eslint-plugin) Lint rules for the mistakes types cannot see
- [olas-codemod](/packages/codemod) Upgrade a 0.8 app to 1.0

</div>
</div>

<div class="home-next">

Next, [Getting started](/guide/getting-started) builds a todo list with a query, a view and a test.

</div>
