# @kontsedal/olas-react

The React adapter for [Olas](../..). A binding layer over `useSyncExternalStore`, about 1.1k lines across five modules: context, hooks, keep-alive and the streaming hydrator. The root is created **outside** React and resolved via context — so React never owns the controller lifetime, no double-construction under StrictMode, and concurrent rendering is safe by construction.

## Install

```bash
pnpm add @kontsedal/olas-react @kontsedal/olas-core @preact/signals-core react react-dom
```

`react >= 18` is a peer dep (we rely on `useSyncExternalStore`).

## 30-second example

```tsx
// counter.ts — controller defined outside React
import { defineController, signal, type ReadSignal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return { count, inc: () => count.update((n) => n + 1) }
})

export type CounterApi = {
  count: ReadSignal<number>
  inc: () => void
}
```

```tsx
// main.tsx — root constructed once
import { createRoot } from '@kontsedal/olas-core'
import { createRoot as createReactRoot } from 'react-dom/client'
import { OlasProvider } from '@kontsedal/olas-react'
import { counter } from './counter'
import { App } from './App'

const root = createRoot(counter, { deps: {} })

createReactRoot(document.getElementById('root')!).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

```tsx
// App.tsx — React reads signals via tiny hooks
import { use, useRoot } from '@kontsedal/olas-react'
import type { CounterApi } from './counter'

export function App() {
  const api = useRoot<CounterApi>()
  return <button onClick={api.inc}>{use(api.count)}</button>
}
```

## API

Every export, grouped by what it is for.

**Reaching the root**

| Export | Purpose |
|---|---|
| `OlasProvider` | Pass a root you created through React context. |
| `useRoot<Api>()` | Resolve the provider's root api. Throws outside a provider. |
| `useController<Api>(root)` | Back-compat — takes the root explicitly (useful in tests). |
| `createOlasContext<Api>(name?)` | Mint an independent Provider + `useRoot` bound to one api type. Use it for two roots in one tree, where the default `useRoot<Api>()` would cast unchecked between them. |
| `<HydrationBoundary def options>` | The client half of SSR: React owns this root, building it from a controller def plus `options.hydrate` and disposing it on unmount. `options` is read once. |

**Reading state**

| Export | Purpose |
|---|---|
| `use(signal)` | Subscribe a component to one `ReadSignal<T>`. |
| `useQuery(state, options?)` | Bundle all 8 signals on an `AsyncState<T>` into one render trigger, plus `refetch`. `{ suspense: true }` throws the in-flight promise on the initial load instead. |
| `useSuspenseQuery(state)` | `useQuery(state, { suspense: true })` without the options bag; `data` is `T`, never `undefined`. |
| `useMutation(mutation, callbacks?)` | Subscribe to a `Mutation`'s signals and get `mutate` / `reset`. The callbacks fire from the React layer — put cache work on the mutation's own spec. |

**Forms**

| Export | Purpose |
|---|---|
| `useField(field)` | Bundle all 5 signals on a `Field<T>` plus its action methods. |
| `useFieldInput(field, options?)` | The same subscription, shaped as input props: `value`, `onChange`, `onBlur`, `name`, `aria-invalid`. Takes a `transform` for non-string fields. |

**Lifetime**

| Export | Purpose |
|---|---|
| `<SuspendOnUnmount controller>` | Suspend a child controller on unmount, resume on remount. Refcounted, so overlapping wrappers during a cross-fade keep it resumed. |
| `KeepAlive` | Deprecated alias of `SuspendOnUnmount`. The old name implied Vue-style DOM preservation, which this does not do. |
| `useSuspendOnHidden(controller)` | Suspend while `document.visibilityState` is hidden; resume on visible, and on unmount if it is still suspended. |

**Streaming SSR** — the server writes `<script>` tags as data lands; the client applies each one as it arrives. See [SPEC §15](../../SPEC.md).

| Export | Purpose |
|---|---|
| `createStreamingHydrator()` | Server side: a `QueryClientPlugin` plus `flush()`, which emits a script tag for every cache entry written since the last call. |
| `createStreamingTransform()` | A `TransformStream` that splices those flushes into an HTML stream. |
| `installStreamingIntake(root)` | Client side: drains the bootstrap queue and applies later chunks to a live root. `HydrationBoundary` installs it for you. |
| `OLAS_BOOTSTRAP_SCRIPT` / `STREAMING_GLOBAL` | The inline bootstrap to put in `<head>`, and the global name it defines. |

Full signatures and gotchas in [`../../API.md`](../../API.md#olasreact).

## Why `useSyncExternalStore`

`useSyncExternalStore` is React 18's official external-store API. It guarantees no tearing under concurrent rendering and works correctly under StrictMode's double-mount. Olas signals are external state from React's perspective; the adapter bridges the two.

The internal pattern: every signal `.subscribe()` fires synchronously with the current value on subscribe. The adapter swallows that first fire (React already has the value from `getSnapshot`) and only translates *actual changes* into store-change notifications.

## Fakes for tests

`@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)` so a component test can be driven without building a real controller:

```tsx
import { fakeField, fakeAsyncState } from '@kontsedal/olas-core/testing'

const profile = {
  draft: fakeField('hello'),
  user: fakeAsyncState({ data: { id: '1', name: 'Alice' } }),
}

render(<UserCard profile={profile} />)
```

The fakes satisfy the real `Field<T>` and `AsyncState<T>` types so they pass `useField` and `useQuery` without casts.

## SSR & hydration

Server rendering goes from `root.dehydrate()` to `<HydrationBoundary>`, plus the streaming hydrator for progressive SSR. One limitation to know: **an infinite query from `defineInfiniteQuery` is not dehydrated**. Its page arrays are skipped, so a server-rendered infinite list refetches its currently-loaded pages on the client after hydration (SPEC §15). Guard the initial client render accordingly (e.g. render a skeleton until `status === 'success'`).

## Further reading

- [`../../API.md`](../../API.md#olasreact) — every export, signature, example.
- [`../../.wiki/modules/react.md`](../../.wiki/modules/react.md) — how each hook is implemented and why.
- [`../../.wiki/flows/use-root.md`](../../.wiki/flows/use-root.md) — end-to-end flow from `createRoot` to DOM.

### SSR query identity in 0.9

Queries included in `root.dehydrate()` must declare an explicit, unique `queryId` shared by the server and client bundles. Anonymous queries fetch on the client. Registration order does not identify queries. Use `bindQuery(ctx, query)` or `root.bindQuery(query)` for imperative operations when multiple roots may be alive.
