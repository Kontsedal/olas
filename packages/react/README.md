# @kontsedal/olas-react

The React adapter for [Olas](../..). A binding layer over `useSyncExternalStore`, about 1.5k lines across four modules: context, hooks, keep-alive and the streaming hydrator. The root is created **outside** React and resolved via context — so React never owns the controller lifetime, no double-construction under StrictMode, and concurrent rendering is safe by construction. The same package runs Preact apps through `preact/compat`.

## Install

```bash
pnpm add @kontsedal/olas-react @kontsedal/olas-core @preact/signals-core react react-dom
```

`react >= 18` is a peer dep (we rely on `useSyncExternalStore`).

## 30-second example

```ts file=counter.ts
// counter.ts — controller defined outside React
import { defineController, signal } from '@kontsedal/olas-core'

export const counter = defineController(() => {
  const count = signal(0)
  return { count, inc: () => count.update((n) => n + 1) }
})
```

```tsx
// main.tsx — root constructed once
import { createRoot } from '@kontsedal/olas-core'
import { OlasProvider } from '@kontsedal/olas-react'
import { createRoot as createReactRoot } from 'react-dom/client'
import { App } from './App'
import { counter } from './counter'

const root = createRoot(counter, { deps: {} })

// Register the root's type once, so `useRoot()` needs no type argument.
declare module '@kontsedal/olas-react' {
  interface Register {
    root: typeof root
  }
}

const container = document.getElementById('root')
if (container === null) throw new Error('Missing #root element')

createReactRoot(container).render(
  <OlasProvider root={root}>
    <App />
  </OlasProvider>,
)
```

```tsx
// App.tsx — React reads signals via tiny hooks
import { useRoot, useValue } from '@kontsedal/olas-react'

export function App() {
  const api = useRoot()
  return <button onClick={api.inc}>{useValue(api.count)}</button>
}
```

`useRoot()` returns `root.api`, the controller's api, typed by the `Register` augmentation. Without one it returns `unknown`, and `useRoot<Api>()` names the type per call as an unchecked cast.

## API

Every export, grouped by what it is for.

**Reaching the root**

| Export | Purpose |
|---|---|
| `OlasProvider` | Pass a root you created through React context. |
| `useRoot()` | Resolve the provider's root api. `Register` types it; `useRoot<Api>()` is an unchecked cast. Throws outside a provider. |
| `Register` / `RegisteredApi` | The interface an app augments once with `root: typeof root`, and the api type it yields. |
| `createOlasContext<Api>(name?)` | Mint an independent Provider + `useRoot` bound to one api type. Use it for two roots in one tree, where one `Register` cannot name both. |
| `<HydrationBoundary def options streaming?>` | The client half of SSR: React owns this root, building it from a controller def plus `options.hydrate` and disposing it on unmount. `options` is read once. It installs the streaming intake unless `streaming={false}`. Put a `<Suspense>` inside it, around what suspends, so the boundary commits before a child suspends. Rendered on the server, it builds a root nothing disposes, and a development build warns once. |

**Reading state**

| Export | Purpose |
|---|---|
| `useValue(signal, options?)` | Subscribe a component to one `ReadSignal<T>`: a `signal`, a `computed`, a `Field`, a `Form` or a `FieldArray`. `{ select, isEqual }` subscribes to a slice. |
| `useQuery(subscription, options?)` | Every field of an `AsyncState<T>` as a plain value, plus `refetch`, `reset` and `cancel`. The component re-renders only for the fields it reads. `{ suspense: true }` throws the in-flight promise on the initial load instead. |
| `useSuspenseQuery(subscription)` | `useQuery(subscription, { suspense: true })` without the options bag; `data` is `T`, never `undefined`. |
| `useInfiniteQuery(subscription, options?)` | `useQuery`'s fields, plus `pages`, `flat`, the four paging flags, `fetchNextPage` and `fetchPreviousPage`. Fine-grained the same way. |
| `useMutation(mutation, callbacks?)` | Subscribe to a `Mutation`'s signals and get `mutate`, `run` and `reset`. The callbacks fire from the React layer — put cache work on the mutation's own hooks. |

**Forms**

| Export | Purpose |
|---|---|
| `useField(field)` | One subscription over a `Field<T>`'s value and validation state, plus its action methods. |
| `useFieldInput(field, options?)` | The same subscription, shaped as input props: `value`, `onChange`, `onBlur`, `name`, `aria-invalid`. Takes a `transform` for non-string fields. |

**Lifetime**

| Export | Purpose |
|---|---|
| `<SuspendOnUnmount controller>` | Suspend a child controller on unmount, resume on remount. Refcounted, so overlapping wrappers during a cross-fade keep it resumed. The React tree still unmounts: DOM, scroll and input state are not kept. |
| `useSuspendOnHidden(controller)` | Suspend while `document.visibilityState` is hidden; resume on visible, and on unmount if it is still suspended. |

**Streaming SSR** — the server writes `<script>` tags as data lands; the client applies each one as it arrives. See [SPEC §15](../../SPEC.md).

| Export | Purpose |
|---|---|
| `createStreamingHydrator(options?)` | Server side: `{ plugin, flush, dispose }`. `flush()` returns a script tag for every cache entry written since the last call. `{ nonce }` puts a CSP nonce on each tag. |
| `createStreamingTransform(flush)` | A `TransformStream` that writes those flushes into an HTML stream, only where the HTML so far sits between elements. |
| `installStreamingIntake(root)` | Client side: drains the bootstrap queue and applies later chunks to a live root. `HydrationBoundary` installs it for you. |
| `OLAS_BOOTSTRAP_SCRIPT` / `STREAMING_GLOBAL` | The inline bootstrap for React's `bootstrapScriptContent`, and the global name it defines. |

Every hook's result type is exported: `UseQueryResult`, `UseInfiniteQueryResult`, `UseMutationResult`, `UseFieldResult` and the rest.

Full signatures and gotchas in [`../../API.md`](../../API.md#kontsedalolas-react).

## `useQuery` re-renders for what the component reads

`useQuery` returns the whole state, and it tracks which fields the component reads during render. The component re-renders only when one of those fields changes. So `const { data } = useQuery(api.user)` does not re-render while a background refetch flips `isFetching`.

- A field read later, in an event handler or an effect, returns its current value and is tracked from then on.
- Spreading the result reads every field, so it tracks every field.
- With `{ suspense: true }`, the hook tracks `data` and `status` itself, because the suspend decision reads them.

`useInfiniteQuery` follows the same rules. A list that renders `flat` and `hasNextPage` does not re-render while `isFetchingPreviousPage` flips.

```tsx
import type { InfiniteQuerySubscription } from '@kontsedal/olas-core'
import { useInfiniteQuery } from '@kontsedal/olas-react'

type Page = { items: string[]; next: number | null }

export function Feed(props: { feed: InfiniteQuerySubscription<Page, string> }) {
  const { flat, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(props.feed)
  return (
    <>
      <ul>
        {flat.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {hasNextPage && (
        <button type="button" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
          More
        </button>
      )}
    </>
  )
}
```

## `useMutation`: `mutate` and `run`

- `mutate(vars)` returns nothing, which suits an event handler. A failure lands on `error` and `status`, and in `onError`. The hook catches the rejection, so it does not become an unhandled one.
- `run(vars)` returns the run's promise, and the caller owns its rejection.
- An aborted run fires none of the callbacks: a superseded `latest-wins` run, a `reset()` or a dispose.

## Why `useSyncExternalStore`

`useSyncExternalStore` is React 18's official external-store API. It guarantees no tearing under concurrent rendering and works correctly under StrictMode's double-mount. Olas signals are external state from React's perspective; the adapter bridges the two.

The internal pattern: every signal `.subscribe()` fires synchronously with the current value on subscribe. The adapter subscribes through `subscribeChanges`, which skips that first call (React already has the value from `getSnapshot`), so only *actual changes* become store-change notifications. A multi-signal hook subscribes once, to a `computed` snapshot of every signal it reads.

## Preact

Besides core, the adapter imports only `react`, not `react-dom`. A Preact app aliases both to `preact/compat` and uses this package as it is:

```js
// vite.config.js
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      react: 'preact/compat',
      'react-dom': 'preact/compat',
    },
  },
})
```

TypeScript needs the same mapping, as `paths` in `tsconfig.json`: `"react": ["./node_modules/preact/compat/"]` and `"react-dom": ["./node_modules/preact/compat/"]`.

`tests/preact-compat.test.tsx` runs the hooks under compat. It pins the provider, `useValue`, the fine-grained `useQuery` under compat's `useSyncExternalStore` shim, `useInfiniteQuery`, `useSuspenseQuery` under compat's `Suspense`, `useFieldInput`, `useMutation` and `SuspendOnUnmount`. `HydrationBoundary`'s StrictMode path is not covered, because compat's `StrictMode` does nothing.

## Fakes for tests

`@kontsedal/olas-core/testing` exports `fakeField<T>(initial, overrides?)` and `fakeAsyncState<T>(overrides?)` so a component test can be driven without building a real controller:

```tsx
import { fakeAsyncState, fakeField } from '@kontsedal/olas-core/testing'
import { render } from '@testing-library/react'
import { UserCard } from './UserCard'

const profile = {
  draft: fakeField('hello'),
  user: fakeAsyncState({ data: { id: '1', name: 'Alice' } }),
}

render(<UserCard profile={profile} />)
```

The fakes satisfy the real `Field<T>` and `AsyncState<T>` types so they pass `useField` and `useQuery` without casts.

## SSR & hydration

Server rendering goes from `root.dehydrate()` to `<HydrationBoundary>`, plus the streaming hydrator for progressive SSR. Each dehydrated entry is keyed by its query's `id`, so the server and client bundles must define each query with the same id. `root.dehydrate()` includes infinite queries with their page params, so a server-rendered list pages on from where the server stopped (SPEC §15). When several roots may be alive, use `bindQuery(ctx, query)` or `root.bindQuery(query)` for imperative query operations.

### Streaming

The server root carries the hydrator's plugin, and the transform writes each batch into React's stream:

```tsx
// server.tsx
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import {
  createStreamingHydrator,
  createStreamingTransform,
  OLAS_BOOTSTRAP_SCRIPT,
  OlasProvider,
} from '@kontsedal/olas-react'
import { renderToReadableStream } from 'react-dom/server'
import { App } from './App'
import { appController } from './app.controller'

export async function renderPage(nonce: string): Promise<Response> {
  const { plugin, flush } = createStreamingHydrator({ nonce })
  const root = createRoot(appController, { deps: {}, queries: queryEngine(), plugins: [plugin] })
  const stream = await renderToReadableStream(
    <OlasProvider root={root}>
      <App />
    </OlasProvider>,
    { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT, nonce },
  )
  return new Response(stream.pipeThrough(createStreamingTransform(flush)), {
    headers: { 'content-type': 'text/html' },
  })
}
```

On the client, `<HydrationBoundary def={appController} options={{ deps, queries: queryEngine() }}>` installs the intake, and each batch lands in the live root as it arrives. Dispose the server root, and call the hydrator's `dispose()`, once the response has finished.

**Let the transform place the tags.** React writes its stream in fixed-size chunks, and a chunk can end inside a tag or an attribute value. A `<script>` written there breaks the markup, and the payload's quotes can close the attribute and add new ones. The transform tracks the markup it passes through and holds a batch until a chunk ends between elements. So do not write `flush()` after each chunk yourself, for example from a Node `Transform`. With Node's `renderToPipeableStream`, render with `renderToReadableStream` instead, or write `flush()` only after the stream has ended.

Each payload goes through core's `serializeForScript`, so query data cannot end the script or turn a `__proto__` key into a prototype on the client. The trust model is SPEC §22.

## Further reading

- [`../../API.md`](../../API.md#kontsedalolas-react) — every export, signature, example.
- [`../../.wiki/modules/react.md`](../../.wiki/modules/react.md) — how each hook is implemented and why.
- [`../../.wiki/flows/use-root.md`](../../.wiki/flows/use-root.md) — end-to-end flow from `createRoot` to DOM.
