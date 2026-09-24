---
name: cross-tab
description: "@kontsedal/olas-cross-tab — an OlasPlugin that mirrors the app's own writes and invalidations of opted-in queries across same-origin tabs over BroadcastChannel."
type: module
covers:
  - packages/cross-tab/src/index.ts
  - packages/cross-tab/src/plugin.ts
  - packages/cross-tab/src/protocol.ts
  - packages/cross-tab/src/channel.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/cross-tab/tests/plugin.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/coverage-edges.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/security.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/non-cloneable.test.ts }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: persist.md }
last_verified: 2026-09-25
confidence: high
---

# `@kontsedal/olas-cross-tab`

One export does the work: `crossTabPlugin(options)`, an `OlasPlugin` that mirrors writes and invalidations of queries marked `meta: { crossTab: true }` over a `BroadcastChannel`. The receiving tab applies each message through its own `host.queries`. Spec §13.2.

## API

```ts nocheck
crossTabPlugin({
  channelName: string                                    // required
  onWarn?: (message: string, cause?: unknown) => void    // default console.warn
  channelFactory?: (name: string) => ChannelLike | undefined
  maxPayloadBytes?: number                               // soft cap, default 512 KB
  optimistic?: boolean                                   // mirror setData and rollbacks; default true
  origins?: readonly string[]                            // other write origins to mirror
  validate?: (queryId: string, data: unknown) => boolean // check a peer's payload
}): OlasPlugin
```

The options type is `CrossTabOptions` (`packages/cross-tab/src/plugin.ts:11-55`). The plugin's name is `CROSS_TAB_PLUGIN_NAME = 'olas-cross-tab'` (`plugin.ts:6`), and it is the `origin` of every write the plugin applies from a peer.

Install it and opt a query in:

```ts
import { createRoot, defineController, defineQuery, queryEngine } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'

export const userQuery = defineQuery({
  id: 'app/user', // names the query in every message
  meta: { crossTab: true }, // the per-query gate, typed by this package
  key: (id: string) => [id],
  fetcher: async ({ signal }, id: string) => (await fetch(`/users/${id}`, { signal })).json(),
})

const app = defineController(() => ({}))

export const root = createRoot(app, {
  deps: {},
  queries: queryEngine(),
  plugins: [crossTabPlugin({ channelName: 'app/cache/v1' })],
})
```

`index.ts:6-15` adds `crossTab?: boolean` to `QueryMeta` through `declare module`. `setup` throws without a query engine (`plugin.ts:108-114`), so `createRoot` fails before any channel opens. Pinned by `coverage-edges.test.ts`, "a root without a query engine fails to construct, before any channel opens".

## Message protocol

A discriminated union, versioned by `v` (`packages/cross-tab/src/protocol.ts:20-43`):

```ts nocheck
type Message =
  | { v: 1; type: 'setData'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[]; data: unknown; pageParams?: readonly unknown[] }
  | { v: 1; type: 'invalidate'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[] }
```

`PROTOCOL_VERSION = 1`. A receiver drops a message whose `v` it does not know. The app supplies the channel name, so an app that wants clean isolation across deploys embeds a version in it, such as `'app/cache/v2'`.

## What crosses: the send gate

`onWrite` and `onInvalidate` (`plugin.ts:252-280`) share one gate, `mirrors` (`plugin.ts:245-249`):

1. **Origin.** An event with `origin: undefined`, the app's own write, crosses. An origin named in `options.origins` crosses too. The plugin's own name never crosses, even when listed. This is the first echo layer: a write this tab applied from a peer carries `origin: 'olas-cross-tab'`, so it is not sent back. The same rule keeps out a write another plugin made. A realtime push reaches every tab by itself, so mirroring it would deliver it twice.
2. **Opt-in.** `event.query.meta.crossTab === true`, for a regular or an infinite query.
3. **Source.** `onWrite` drops `'fetch'` and `'hydrate'` (`plugin.ts:254`). Each tab runs its own fetcher and hydrates its own payload, so mirroring those would be N-tab noise that changes no cache. With `optimistic: false` it also drops `'optimistic'` and `'rollback'` (`plugin.ts:255-257`).

So by default `setData`, its rollback, `write` and `replace` cross. An infinite write carries its `pageParams` (`plugin.ts:266`). `onInvalidate` passes through the origin and opt-in gates only.

An `entities.update(...)` backprop carries `origin: 'olas-entities'`, so by default it stays in the tab that made it. The default fits an update every tab makes for itself, such as one realtime push each tab folds into its own store. An app that updates entities from one tab's UI lists `ENTITIES_PLUGIN_NAME` in `origins`, as the package README shows under "Whose writes cross".

Pinned by `plugin.test.ts`: "2. no echo", "11a. fetch-success writes are NOT broadcast", "14. writes another plugin or a tagged handle made are not mirrored", "15. optimistic: false mirrors only canonical writes", "3. crossTab: false queries stay isolated" and the three infinite-query cases. `coverage-edges.test.ts` pins that listing the plugin's own name in `origins` still sends nothing back.

## The receive side

The channel `listener` (`plugin.ts:163-212`) drops a message at the first check it fails:

1. a payload that is not an object, or a `v` other than `PROTOCOL_VERSION`;
2. its own `sourceId`, for a transport that echoes to the sender;
3. a `sourceId` that is not a string, or a `msgId` that is not a safe non-negative integer or is not above the last one seen from that peer. The per-peer cursors keep 64 peers and evict the oldest (`plugin.ts:125-134`).
4. a `queryId` that is not a string or `keyArgs` that is not an array, with an `onWarn`;
5. a query this root has not used or has not opted in (`accepts`, `plugin.ts:137-140`). `host.queries.get` knows only queries this root has bound, so the receive gate mirrors the send gate.

A `setData` message then also fails on a `pageParams` that is not an array, or on a `validate` that returns `false` or throws. It lands through `queries.write(queryId, keyArgs, () => data, { pageParams })` (`plugin.ts:199-206`), and an `invalidate` through `queries.invalidate` (`plugin.ts:209-211`).

Pinned by "10. out-of-order / duplicate messages are deduped", "13. receive-side filter — inbound writes for locally non-opted queries are ignored (T6.4)", and the `coverage-edges.test.ts` groups "inbound guards" and "per-peer cursor cap".

## Apply semantics: the entry must already exist

`host.queries.write` and `invalidate` address an entry by id and key, and do nothing when this root holds no entry for that key (`packages/core/src/query/client.ts:954-963`, `client.ts:878-884`). A message for a key no subscriber here has bound is therefore dropped. The receiver has no call args it could refetch that key with, and seeding rows the user never asked for leaks. A subscriber that mounts later fetches on its own.

A peer's write lands here as a canonical `'write'`, whatever its source was on the sender. A peer's optimistic value therefore holds no snapshot in this tab, and the peer's rollback arrives as one more write. A remote invalidate refetches a subscribed entry and marks an unsubscribed one stale (`client.ts:1383-1410`). Pinned by "1. setData in tab A is reflected in tab B" and "5. invalidation propagates → receiving tab refetches".

## Non-cloneable and oversized payloads

`BroadcastChannel` uses structured clone, so functions, class instances and symbols throw `DataCloneError` at `postMessage`. `send` catches it, calls `onWarn` and drops the broadcast (`plugin.ts:233-241`). The sender's cache is unaffected, because the write completed before the broadcast. Pinned by "6. non-cloneable data triggers onWarn; sender cache unaffected" and `non-cloneable.test.ts`.

Before posting, `send` estimates the size as the message's JSON length. Over `maxPayloadBytes` it warns and still posts (`plugin.ts:218-232`). `Infinity` turns the check off. Pinned by the `coverage-edges.test.ts` "outbound payload estimate" group.

## SSR no-op

`channelFactory` defaults to `defaultChannelFactory`, which returns `undefined` when `typeof BroadcastChannel === 'undefined'` (`packages/cross-tab/src/channel.ts:21-41`). `setup` then returns no hooks (`plugin.ts:115-117`), and the root boots with cross-tab off. The root still needs a query engine, because the engine check comes first. Pinned by "7. SSR — channelFactory returning undefined yields a no-op plugin" and `ssr.test.ts`.

## Interaction with `@kontsedal/olas-persist`

The two packages sync at different levels:

- `createPersisted` in `@kontsedal/olas-persist` mirrors **durable** signal state through `localStorage` and the `storage` event.
- `persistQueryCachePlugin` in the same package writes the query cache to storage, so a reload starts from it. It does not sync live tabs.
- `@kontsedal/olas-cross-tab` mirrors the **in-memory** query cache between live tabs and writes nothing to disk.

Layering cross-tab and `createPersisted` on the same logical state works but is redundant. See `persist.md`.

## Test harness caveat

In a browser each tab evaluates its own modules, so a query's `__clients` set holds only the local client. In a single-process test, two roots that bind one `defineQuery` value both land in its `__clients`. An unbound `query.setData(...)` then throws as ambiguous (`packages/core/src/query/actions.ts:10-18`). `plugin.test.ts` handles this two ways. The `mountTabs` cases mint one `defineQuery` value per tab with the same `id`, so each unbound call reaches one client. The newer cases share one value and write through a bound handle. Routing by id is per root in either case, because each root's `host.queries` resolves ids through its own `byId` index.

## Conflict model: last delivery wins, no arbitration

No consensus and no clocks: each tab applies incoming writes in delivery order. Two tabs writing the same entry at once can settle on different values and stay diverged, because nothing reconciles them. The fix is a server refetch: `query.invalidate(...)` crosses tabs, so every tab re-converges on server truth. The package README documents this.

## Limitations

- **Infinite queries sync with `meta: { crossTab: true }`, like regular ones.** A `setData` message for one carries `pageParams`, and the receiver writes the pages and their params together. Pinned by "the receiving tab stores the params that came with the pages".
- **No structural diffs.** Each write broadcasts the full value after the write. That suits an in-memory `BroadcastChannel`, and costs more for large entries.
- **Optimistic writes cross by default.** A peer shows a pending edit and its rollback. `optimistic: false` limits the channel to canonical writes and invalidations.

## Receiving untrusted messages (1.0)

Any same-origin script can post on the channel. The listener ignores a `msgId` that is not a safe non-negative integer (`plugin.ts:173-175`), since `Number.MAX_VALUE` under a real peer's `sourceId` would silence that peer. It applies a message inside a try that reports to `onWarn` (`plugin.ts:147-153`). A key the engine cannot hash, such as a cycle, therefore does not throw out of the event handler. The `validate(queryId, data)` option rejects a payload shape the tab does not expect. Pinned by `tests/security.test.ts`; see `../decisions/trust-model.md`.
