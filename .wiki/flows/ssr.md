---
name: ssr
description: Server-side waitForIdle and dehydrate, client-side hydrate, and streaming SSR through the streaming hydrator plugin and the intake.
type: flow
covers:
  - packages/core/src/query/client.ts:107-217
  - packages/core/src/query/client.ts:1160-1304
  - packages/core/src/query/client.ts:1355-1438
  - packages/core/src/query/client.ts:1469-1528
  - packages/core/src/query/client.ts:1833-1894
  - packages/core/src/controller/root.ts:179-231
  - packages/core/src/query/bind.ts:91-138
  - packages/core/src/query/entry.ts:129-140
  - packages/core/src/query/entry.ts:606-676
  - packages/core/src/query/keys.ts
  - packages/react/src/streaming.ts
  - packages/react/src/context.ts:140-408
edges:
  - { type: tested-by, target: ../../packages/core/tests/cache-identity.test.ts }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/core/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/core/tests/local-cache-writes.test.ts }
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

`hydrate` needs `queries`. Without an engine, `createRoot` discards the payload with a development warning (`packages/core/src/controller/root.ts:44-51`), and `root.hydrate` does the same (`root.ts:184-197`).

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

`QueryClient.dehydrate` (`packages/core/src/query/client.ts:1355-1382`) includes every entry that holds data, and an entry at `status: 'success'` without data. An entry with no data that is pending, errored or idle is not serialized, because it would be useless on the client. `status` alone was the test before the second 1.0 pass. It reads `'pending'` over the data during a background refetch and `'error'` after a failed one, so a dehydrate at those moments dropped an entry holding data. Pinned by `ssr.test.ts`, "an entry holding data mid-refetch is serialized". An infinite entry carries its pages in `data` and one param per page in `pageParams`, and the client seeds the pages without refetching them. See `../decisions/infinite-query-parity.md`.

`key` is `spec.key(...callArgs)`, and `id` is the query's required `id`, identical in the server and client bundles. `defineQuery` and `defineInfiniteQuery` throw on a missing or empty `id`, through `assertId` (`packages/core/src/query/define.ts:12-19`), so every entry holding data is dehydrated and no anonymous fallback exists. Registration order plays no part in identity. `cache-identity.test.ts` pins this: "reversed registration order is safe" evaluates separate module copies in opposite orders, and "a query without an id is rejected at definition time". A hand-authored payload must set each entry's `id` to the target query's `id`.

## What hydration does

Two entry points take a payload, and both drop one whose `version` is not `1` with a development warning (`acceptsState`, `client.ts:1160-1172`):

- **`RootOptions.hydrate`** reaches `QueryClient.hydrate` from the constructor (`client.ts:887`, `client.ts:1273-1284`). It creates no entries. It buffers each row in `hydratedData`, keyed by `hydrationKey(id, keyHash) = JSON.stringify([id, keyHash])` (`client.ts:107-114`). The key includes the query's identity, so a query B whose key hashes the same cannot adopt query A's payload. That is T1.2, pinned by `regressions.test.ts` under R-Q1.2.
- **`root.hydrate(state)`** and `host.queries.hydrate(state)` reach `QueryClient.hydrateLive` (`client.ts:1267-1270`). `applyDehydratedEntry` writes a row straight into an entry this root already holds, through `Entry.applyHydration`, and buffers the rest (`client.ts:1214-1260`).

Both paths buffer through `bufferRow`, which keeps the newest row per key: a row stamped before the one already waiting is dropped. The buffer used to take rows as they came, so an older row replaced a newer one and the first bind showed it. Pinned by `ssr.test.ts`, "a buffered row is not replaced by an older one".

A buffered row is consumed on the first `bindEntry` or `bindInfiniteEntry` of its key (`client.ts:1469-1487`, `client.ts:1833-1859`). The new entry starts with `initialData` and `initialUpdatedAt`, so it is in `status: 'success'` from the start. An infinite entry adopts a row only when `pageParams` has one param per page (`infinitePayload`, `client.ts:199-206`).

The row's key crosses JSON, and the client re-hashes it. `stableHash` (`keys.ts:21-23`) hashes the value JSON round-trips a key to (spec §5.4). An `undefined` member is absent, `undefined` in an array and a non-finite number are `null`, and a Date is its ISO string. Before, `{ q: undefined }` hashed apart from the `{}` the client received, so the client never adopted the row, mounted `pending` and refetched. A persisted cache hit the same miss. A bigint keeps its tag and has no JSON form. Pinned by `ssr.test.ts`, "dehydrated keys survive the JSON trip".

Each row is consumed once. If a controller disposes and the key is bound again later, the row is gone and the second bind fetches as usual. This is intentional: hydration is a warm start, not a permanent cache.

`Entry.applyHydration` (`packages/core/src/query/entry.ts:630-676`) supersedes any fetch in flight, rebases live optimistic snapshots onto the server data, and reports nothing itself. It skips a row stamped before the entry's `serverUpdatedAt` and returns `false`, so a late streamed row cannot revert newer server data; `InfiniteEntry.applyHydration` does the same. `serverUpdatedAt` moves on a fetch, a hydrated row or a canonical write, and not on an optimistic `setData`. The check read `lastUpdatedAt` before the second 1.0 pass, and an optimistic write then made a newer row look old. A row stamped at or after the entry's latest invalidation clears the stale mark, for both kinds (spec §5.7). A row stamped before it leaves the mark, and an entry that someone holds then fetches once more, since the row superseded the invalidation's fetch. See `../entities/entry.md`. The client reports exactly one `'hydrate'` write to plugins per row it applies, from either path, and none for a skipped row. Pinned by `plugin-host.test.ts`: "hydrating a bound entry reports ONE write, as hydrate" and "a buffered payload reports as hydrate when its entry binds".

Each malformed entry is skipped with a development warning (`eachHydrationEntry`, `client.ts:1292-1304`), so one bad row cannot fail `createRoot`. Pinned by `regressions.test.ts`, "a malformed hydration payload".

## `staleTime` interaction

A hydrated entry's `lastUpdatedAt` comes from the payload. On subscribe, `isStaleNow()` checks `Date.now() - lastUpdatedAt >= staleTime`. A fresh entry does not refetch. A stale one refetches in the background: the data stays, `isFetching` turns true, and `status` reads `'pending'` until the refetch lands (spec §5.3).

A stamp ahead of the client's clock is read as the client's now, through `notInFuture` (`entry.ts:136-140`), on the buffered path and the live one. A negative age used to read `isStale` with `staleTime: 0` yet never refetch, and keep data fresh past `staleTime`. Pinned by `ssr.test.ts`, "a server clock ahead of the client".

`ssr.test.ts`, "hydrated entries respect staleTime: 0 (refetch on subscribe)", pins this. The default `staleTime: 0` makes hydrated data stale at once, so the client refetches once. Set `staleTime: 60_000` or similar to skip that refetch.

## `waitForIdle()`

The server uses it to know when to dehydrate. `root.waitForIdle()` (`root.ts:214-231`) wraps the client's wait in a loop that also waits for plugin work and for `createCache` local caches:

```ts nocheck
// root.waitForIdle
for (let round = 0; round < 100; round++) {
  await queryClient?.waitForIdle()
  const work = plugins?.pendingWork() ?? []   // promises plugins passed to host.track
  for each live createCache in RootShared.localCaches: if it is fetching, wait until it is not
  if (work.length === 0) return
  await Promise.all(work)
}
throw new Error('[olas] waitForIdle: plugin work or local-cache fetches kept restarting for 100 rounds')

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

The client's `waitForIdle` loop re-checks because a new fetch can start during the wait: a `refetchInterval` fires, or one fetch's success starts an effect that fetches again (`client.ts:1384-1438`). Plugin work can start fetches too, such as a startup replay, and a settling fetch can start plugin work, hence the outer loop. Both loops give up after 100 rounds and throw, so a runaway setup fails the render instead of dehydrating an incomplete payload.

A local cache is not a query-client entry, so the client's loop cannot see it. `createCache` registers each cache through `ctxInternals.trackLocalCache` into `RootShared.localCaches`, and the cache's own `dispose` removes it, whether the cache disposes early or with its controller (1.0). The root's loop reads that set, so a root without a query engine waits for its local caches too. Before 1.0 the docs told SSR code to await `cache.firstValue()` instead. Pinned by `local-cache-writes.test.ts`, "root.waitForIdle() counts createCache fetches".

`mutationsInflight$` is a `Signal<number>` on the client. `MutationImpl` increments it when a run starts and decrements it in `finally`, and a queued `serial` run counts too. Pinned by the `waitForIdle` tests in `ssr.test.ts` and "track() makes waitForIdle wait for the work" in `plugin-host.test.ts`.

## Streaming SSR

The `waitForIdle` → `dehydrate` path serializes the cache once, *after* the slowest query resolves, which blocks the response on the slowest fetcher. Streaming SSR sends each entry into the HTML stream as it resolves.

### Server

`createStreamingHydrator({ nonce? })` (`packages/react/src/streaming.ts:126-194`) returns `{ plugin, flush, dispose }`. The plugin's `onWrite` captures committed writes, meaning sources `'fetch'`, `'write'` and `'replace'`, deduplicated per query id and key hash so the latest value wins. It skips `'hydrate'`, data the client already has, and `'optimistic'` and `'rollback'`, guesses the server never confirmed. An infinite entry carries its `pageParams`. `flush()` drains the captured entries into one `<script>` tag, with the payload built by `serializeForScript`. `dispose()` drops what is captured, after the stream closes.

`createStreamingTransform(flush)` (`streaming.ts:361-387`) is a `TransformStream` over React's HTML stream. It writes a batch only where the HTML so far sits between elements, tracked by the `HtmlBoundary` tokenizer (`streaming.ts:221-320`). React writes fixed-size chunks, and a chunk can end inside a tag or an attribute value, where a `<script>` would break the markup and its payload could inject attributes (`../pitfalls/stream-chunks-split-tags.md`). The transform drains once more on close.

<!-- snippet-prelude
import type { ControllerDef } from '@kontsedal/olas-core'
declare const appDef: ControllerDef<void, unknown>
declare const App: () => null
-->
```tsx
import { createRoot, queryEngine } from '@kontsedal/olas-core'
import {
  createStreamingHydrator,
  createStreamingTransform,
  OLAS_BOOTSTRAP_SCRIPT,
  OlasProvider,
} from '@kontsedal/olas-react'
import { renderToReadableStream } from 'react-dom/server'

export async function handle(nonce: string): Promise<Response> {
  const { plugin, flush } = createStreamingHydrator({ nonce })
  // The plugin goes on the SAME root that renders: one root per request,
  // rendered through OlasProvider. A HydrationBoundary would build its root in
  // render and dispose it in an effect, and effects never run on the server.
  const root = createRoot(appDef, { deps: {}, queries: queryEngine(), plugins: [plugin] })
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

With Node's `renderToPipeableStream`, the package docs advise rendering with `renderToReadableStream` instead, since Node has Web Streams, or writing `flush()` output only after the stream has ended (`streaming.ts:69-76`). Writing it between React's chunks is the unsafe case above. `nonce` goes on every tag, for a `script-src 'nonce-…'` policy.

### Client

`OLAS_BOOTSTRAP_SCRIPT` primes `self.__OLAS_HYDRATION__` as a push-only queue before React hydrates (`streaming.ts:50`). Each flushed tag pushes its batch there, and checks first that the global is an intake, so a page element with that id cannot clobber it.

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

`HydrationBoundary` creates and owns the client root, and once it commits it calls `installStreamingIntake(root)` on it (`packages/react/src/context.ts:400-405`). The intake (`streaming.ts:398-451`):

1. upgrades the bootstrap queue into a fan-out intake that keeps every batch it has seen;
2. applies the batches that arrived before mount to this root;
3. applies each later batch to every installed root.

A second boundary, or the fresh root of a StrictMode remount, therefore catches up on the stream instead of taking it from the first root. Each batch goes through `root.hydrate(state)` inside one signal `batch(...)`, so subscribers see one notification per batch. Hydration then follows the rules above: a bound entry takes the row now, and an unbound key buffers it until its first bind. Uninstalling removes only this root's sink, and later batches keep queueing for the next root.

Pinned by `streaming.test.tsx` (capture and flush, the intake draining and forwarding, several roots, the transform, and an infinite query streamed with its params) and `streaming-security.test.tsx`.

## The React round trip

`packages/react/tests/ssr-hydration.test.tsx` puts `renderToString` and `hydrateRoot` on the same markup. The first case builds a server root, waits, renders and dehydrates. It then hydrates a client root with that state over the HTML and asserts `onRecoverableError` never fired. The second hydrates the same HTML against a root with no state, whose query never settles, and watches the mismatch fire, which proves the check has teeth. See `../modules/react.md`.
