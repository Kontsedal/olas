---
name: ssr
description: Server-side waitForIdle and dehydrate, client-side hydrate, and streaming SSR through the streaming hydrator plugin and the intake.
type: flow
covers:
  - packages/core/src/query/client.ts:107-148
  - packages/core/src/query/client.ts:989-1115
  - packages/core/src/query/client.ts:1159-1242
  - packages/core/src/query/client.ts:1273-1332
  - packages/core/src/query/client.ts:1625-1686
  - packages/core/src/controller/root.ts:156-201
  - packages/core/src/query/entry.ts:406-455
  - packages/react/src/streaming.ts
  - packages/react/src/context.ts:118-229
edges:
  - { type: tested-by, target: ../../packages/core/tests/cache-identity.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/infinite-parity.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/plugin-host.test.ts }
  - { type: tested-by, target: ../../packages/react/tests/ssr-hydration.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/streaming.test.tsx }
  - { type: tested-by, target: ../../packages/react/tests/streaming-security.test.tsx }
  - { type: uses, target: ../entities/query-client.md }
  - { type: uses, target: ../modules/react.md }
  - { type: uses, target: plugin-lifecycle.md }
  - { type: related, target: ../decisions/infinite-query-parity.md }
  - { type: related, target: ../decisions/trust-model.md }
last_verified: 2026-09-25
confidence: high
---

# Flow: SSR

Spec §15.

## The pattern

On the server, build the root, wait for the cache, and serialize it:

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const rootController: ControllerDef<void, unknown>
-->
```ts
import { createRoot, queryEngine, serializeForScript } from '@kontsedal/olas-core'

export async function renderState(): Promise<string> {
  const root = createRoot(rootController, { queries: queryEngine(), deps: {} })
  await root.waitForIdle()
  const state = root.dehydrate()
  root.dispose()
  // Query data is untrusted text: serializeForScript escapes it for an inline <script>.
  return `<script>window.__OLAS_STATE__ = ${serializeForScript(state)}</script>`
}
```

On the client, build the root with the payload:

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const rootController: ControllerDef<void, unknown>
declare global {
  interface Window { __OLAS_STATE__?: import('@kontsedal/olas-core').DehydratedState }
}
-->
```ts
import { createRoot, queryEngine } from '@kontsedal/olas-core'

export const root = createRoot(rootController, {
  queries: queryEngine(),
  deps: {},
  hydrate: window.__OLAS_STATE__, // subscriptions find the data already present
})
```

Only the query cache is serialized, never controller state. Controllers reconstruct from props on the client, re-running their factories and re-subscribing. The subscriptions find the hydrated data and fetch only when it is stale for their `staleTime`. `examples/reader-ssr` runs this pattern end to end (`src/entry-server.tsx`, `src/entry-client.tsx`, `src/page.ts`).

`hydrate` needs `queries`. Without an engine, `createRoot` discards the payload with a development warning (`packages/core/src/controller/root.ts:43-50`), and `root.hydrate` does the same (`root.ts:161-174`).

## What `dehydrate()` emits

```ts nocheck
{
  version: 1,
  entries: [
    { id: query.id, key: keyArgs, data, lastUpdatedAt },
    { id: infinite.id, key: keyArgs, data: pages, pageParams, lastUpdatedAt },
    ...
  ]
}
```

`QueryClient.dehydrate` (`packages/core/src/query/client.ts:1159-1186`) includes only entries with `status: 'success'`. Errors and pending fetches are not serialized, because they would be useless on the client. An infinite entry carries its pages in `data` and one param per page in `pageParams`, and the client seeds the pages without refetching them. See `../decisions/infinite-query-parity.md`.

`key` is `spec.key(...callArgs)`, and `id` is the query's required `id`, identical in the server and client bundles. `defineQuery` and `defineInfiniteQuery` throw on a missing or empty `id` (`packages/core/src/query/define.ts:12-19`), so every successful entry is dehydrated and no anonymous fallback exists. Registration order plays no part in identity. `cache-identity.test.ts` pins this: "reversed registration order is safe" evaluates separate module copies in opposite orders, and "a query without an id is rejected at definition time". A hand-authored payload must set each entry's `id` to the target query's `id`.

## What hydration does

Two entry points take a payload, and both drop one whose `version` is not `1` with a development warning (`acceptsState`, `client.ts:989-1001`):

- **`RootOptions.hydrate`** reaches `QueryClient.hydrate` from the constructor (`client.ts:731`, `client.ts:1084-1095`). It creates no entries. It buffers each row in `hydratedData`, keyed by `hydrationKey(id, keyHash) = JSON.stringify([id, keyHash])` (`client.ts:107-114`). The key includes the query's identity, so a query B whose key hashes the same cannot adopt query A's payload. That is T1.2, pinned by `regressions.test.ts` under R-Q1.2.
- **`root.hydrate(state)`** and `host.queries.hydrate(state)` reach `QueryClient.hydrateLive` (`client.ts:1078-1081`). `applyDehydratedEntry` writes a row straight into an entry this root already holds, through `Entry.applyHydration`, and buffers the rest (`client.ts:1043-1071`).

A buffered row is consumed on the first `bindEntry` or `bindInfiniteEntry` of its key (`client.ts:1286-1311`, `client.ts:1642-1656`). The new entry starts with `initialData` and `initialUpdatedAt`, so it is in `status: 'success'` from the start. An infinite entry adopts a row only when `pageParams` has one param per page (`infinitePayload`, `client.ts:132-139`).

Each row is consumed once. If a controller disposes and the key is bound again later, the row is gone and the second bind fetches as usual. This is intentional: hydration is a warm start, not a permanent cache.

`Entry.applyHydration` (`packages/core/src/query/entry.ts:420-455`) supersedes any fetch in flight, rebases live optimistic snapshots onto the server data, and reports nothing itself. The client reports exactly one `'hydrate'` write to plugins per row, from either path. Pinned by `plugin-host.test.ts`: "hydrating a bound entry reports ONE write, as hydrate" and "a buffered payload reports as hydrate when its entry binds".

Each malformed entry is skipped with a development warning (`eachHydrationEntry`, `client.ts:1103-1115`), so one bad row cannot fail `createRoot`. Pinned by `regressions.test.ts`, "a malformed hydration payload".

## `staleTime` interaction

A hydrated entry's `lastUpdatedAt` comes from the payload. On subscribe, `isStaleNow()` checks `Date.now() - lastUpdatedAt >= staleTime`. A fresh entry does not refetch. A stale one refetches in the background, with `status` staying `'success'` while `isFetching` turns true.

`ssr.test.ts`, "hydrated entries respect staleTime: 0 (refetch on subscribe)", pins this. The default `staleTime: 0` makes hydrated data stale at once, so the client refetches once. Set `staleTime: 60_000` or similar to skip that refetch.

## `waitForIdle()`

The server uses it to know when to dehydrate. `root.waitForIdle()` (`root.ts:191-201`) wraps the client's wait in a loop that also waits for plugin work:

```ts nocheck
// root.waitForIdle
for (let round = 0; round < 100; round++) {
  await queryClient?.waitForIdle()
  const work = plugins?.pendingWork() ?? []   // promises plugins passed to host.track
  if (work.length === 0) return
  await Promise.all(work)
}
throw new Error('[olas] waitForIdle: plugin work kept restarting for 100 rounds')

// QueryClient.waitForIdle
for (let safety = 0; safety < 100; safety++) {
  const tasks = []
  for each entry in maps and infiniteMaps: if entry.isFetching.peek(), wait until it is false
  if mutationsInflight$.peek() > 0: wait until it is 0
  if (tasks.length === 0) return
  await Promise.all(tasks)
}
throw an error listing the entries still fetching
```

The client's loop re-checks because a new fetch can start during the wait: a `refetchInterval` fires, or one fetch's success starts an effect that fetches again (`client.ts:1188-1242`). Plugin work can start fetches too, such as a startup replay, and a settling fetch can start plugin work, hence the outer loop. Both loops give up after 100 rounds and throw, so a runaway setup fails the render instead of dehydrating an incomplete payload.

`mutationsInflight$` is a `Signal<number>` on the client. `MutationImpl` increments it when a run starts and decrements it in `finally`, and a queued `serial` run counts too. Pinned by the `waitForIdle` tests in `ssr.test.ts` and "track() makes waitForIdle wait for the work" in `plugin-host.test.ts`.

## Streaming SSR

The `waitForIdle` → `dehydrate` path serializes the cache once, *after* the slowest query resolves, which blocks the response on the slowest fetcher. Streaming SSR sends each entry into the HTML stream as it resolves.

### Server

`createStreamingHydrator({ nonce? })` (`packages/react/src/streaming.ts:118-186`) returns `{ plugin, flush, dispose }`. The plugin's `onWrite` captures committed writes, meaning sources `'fetch'`, `'write'` and `'replace'`, deduplicated per query id and key hash so the latest value wins. It skips `'hydrate'`, data the client already has, and `'optimistic'` and `'rollback'`, guesses the server never confirmed. An infinite entry carries its `pageParams`. `flush()` drains the captured entries into one `<script>` tag, with the payload built by `serializeForScript`. `dispose()` drops what is captured, after the stream closes.

`createStreamingTransform(flush)` (`streaming.ts:350-376`) is a `TransformStream` over React's HTML stream. It writes a batch only where the HTML so far sits between elements, tracked by the `HtmlBoundary` tokenizer (`streaming.ts:213-312`). React writes fixed-size chunks, and a chunk can end inside a tag or an attribute value, where a `<script>` would break the markup and its payload could inject attributes (`../pitfalls/stream-chunks-split-tags.md`). The transform drains once more on close.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const appDef: ControllerDef<void, unknown>
declare const App: () => null
-->
```tsx
import { queryEngine } from '@kontsedal/olas-core'
import {
  createStreamingHydrator,
  createStreamingTransform,
  HydrationBoundary,
  OLAS_BOOTSTRAP_SCRIPT,
} from '@kontsedal/olas-react'
import { renderToReadableStream } from 'react-dom/server'

export async function handle(nonce: string): Promise<Response> {
  const { plugin, flush } = createStreamingHydrator({ nonce })
  // The plugin goes on the SAME root that renders, through the boundary's options.
  const stream = await renderToReadableStream(
    <HydrationBoundary def={appDef} options={{ deps: {}, queries: queryEngine(), plugins: [plugin] }}>
      <App />
    </HydrationBoundary>,
    { bootstrapScriptContent: OLAS_BOOTSTRAP_SCRIPT, nonce },
  )
  return new Response(stream.pipeThrough(createStreamingTransform(flush)), {
    headers: { 'content-type': 'text/html' },
  })
}
```

With Node's `renderToPipeableStream`, the package docs advise rendering with `renderToReadableStream` instead, since Node has Web Streams, or writing `flush()` output only after the stream has ended (`streaming.ts:67-75`). Writing it between React's chunks is the unsafe case above. `nonce` goes on every tag, for a `script-src 'nonce-…'` policy.

### Client

`OLAS_BOOTSTRAP_SCRIPT` primes `self.__OLAS_HYDRATION__` as a push-only queue before React hydrates (`streaming.ts:48`). Each flushed tag pushes its batch there, and checks first that the global is an intake, so a page element with that id cannot clobber it.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const appDef: ControllerDef<void, unknown>
declare const App: () => null
-->
```tsx
import { queryEngine } from '@kontsedal/olas-core'
import { HydrationBoundary } from '@kontsedal/olas-react'
import { hydrateRoot } from 'react-dom/client'

hydrateRoot(
  document.getElementById('app') as HTMLElement,
  <HydrationBoundary def={appDef} options={{ deps: {}, queries: queryEngine() }}>
    <App />
  </HydrationBoundary>,
)
```

`HydrationBoundary` creates and owns the client root, and on mount it calls `installStreamingIntake(root)` (`packages/react/src/context.ts:218-226`). The intake (`streaming.ts:387-440`):

1. upgrades the bootstrap queue into a fan-out intake that keeps every batch it has seen;
2. applies the batches that arrived before mount to this root;
3. applies each later batch to every installed root.

A second boundary, or the fresh root of a StrictMode remount, therefore catches up on the stream instead of taking it from the first root. Each batch goes through `root.hydrate(state)` inside one signal `batch(...)`, so subscribers see one notification per batch. Hydration then follows the rules above: a bound entry takes the row now, and an unbound key buffers it until its first bind. Uninstalling removes only this root's sink, and later batches keep queueing for the next root.

Pinned by `streaming.test.tsx` (capture and flush, the intake draining and forwarding, several roots, the transform, and an infinite query streamed with its params) and `streaming-security.test.tsx`.

## The React round trip

`packages/react/tests/ssr-hydration.test.tsx` puts `renderToString` and `hydrateRoot` on the same markup. The first case builds a server root, waits, renders and dehydrates. It then hydrates a client root with that state over the HTML and asserts `onRecoverableError` never fired. The second hydrates the same HTML against a root with no state, whose query never settles, and watches the mismatch fire, which proves the check has teeth. See `../modules/react.md`.
