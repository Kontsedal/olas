---
name: cross-tab
description: "@kontsedal/olas-cross-tab — an OlasPlugin that mirrors the app's own writes and invalidations of opted-in queries across same-origin tabs over BroadcastChannel, why an entities patch stays in its tab by default, and the devtools lane."
type: module
covers:
  - packages/cross-tab/src/index.ts
  - packages/cross-tab/src/plugin.ts
  - packages/cross-tab/src/protocol.ts
  - packages/cross-tab/src/channel.ts
  - packages/cross-tab/tsdown.config.ts
edges:
  - { type: related, target: ../decisions/trust-model.md }
  - { type: related, target: ../decisions/plugin-host-v2.md }
  - { type: related, target: ../decisions/esm-only-build.md }
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/cross-tab/tests/plugin.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/coverage-edges.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/security.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/non-cloneable.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/devtools-lane.test.ts }
  - { type: tested-by, target: ../../packages/integration/tests/cross-tab-entities.test.ts }
  - { type: uses, target: ../flows/plugin-lifecycle.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: persist.md }
  - { type: related, target: entities.md }
  - { type: related, target: devtools-panel.md }
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

The options type is `CrossTabOptions` (`packages/cross-tab/src/plugin.ts:11-59`). The plugin's name is `CROSS_TAB_PLUGIN_NAME = 'olas-cross-tab'` (`plugin.ts:6`), and it is the `origin` of every write the plugin applies from a peer.

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

`index.ts:6-15` adds `crossTab?: boolean` to `QueryMeta` through `declare module`. `setup` throws without a query engine (`plugin.ts:124-131`), so `createRoot` fails before any channel opens. Pinned by `coverage-edges.test.ts`, "a root without a query engine fails to construct, before any channel opens".

## Message protocol

A discriminated union, versioned by `v` (`packages/cross-tab/src/protocol.ts:22-54`):

```ts nocheck
type Message =
  | { v: 1; type: 'setData'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[]; data: unknown; pageParams?: readonly unknown[] }
  | { v: 1; type: 'invalidate'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[] }
```

`PROTOCOL_VERSION = 1`. A receiver drops a message whose `v` it does not know. The app supplies the channel name, so an app that wants clean isolation across deploys embeds a version in it, such as `'app/cache/v2'`.

## What crosses: the send gate

`onWrite` and `onInvalidate` (`plugin.ts:306-334`) share one gate, `mirrors` (`plugin.ts:298-303`):

1. **Origin.** An event with `origin: undefined`, the app's own write, crosses. An origin named in `options.origins` crosses too. The plugin's own name never crosses, even when listed. This is the first echo layer: a write this tab applied from a peer carries `origin: 'olas-cross-tab'`, so it is not sent back. The same rule keeps out a write another plugin made. A realtime push reaches every tab by itself, so mirroring it would deliver it twice.
2. **Opt-in.** `event.query.meta.crossTab === true`, for a regular or an infinite query.
3. **Source.** `onWrite` drops `'fetch'` and `'hydrate'` (`plugin.ts:308`). Each tab runs its own fetcher and hydrates its own payload, so mirroring those would be N-tab noise that changes no cache. With `optimistic: false` it also drops `'optimistic'` and `'rollback'` (`plugin.ts:309-311`).

So by default `setData`, its rollback, `write` and `replace` cross. An infinite write carries its `pageParams` (`plugin.ts:320`). `onInvalidate` passes through the origin and opt-in gates only.

An `entities.update(...)` backprop carries `origin: 'olas-entities'`, so by default it stays in the tab that made it. An app that updates entities from one tab's UI lists `ENTITIES_PLUGIN_NAME` in `origins`, as the package README shows under "Whose writes cross".

### Decision: the entities origin stays opt-in (1.0)

The 1.0 backlog asked whether cross-tab should mirror the entities origin by default. It does not, for three reasons, each pinned by `packages/integration/tests/cross-tab-entities.test.ts`:

1. **A mirrored app write already reaches the peer's store.** The peer applies it with `origin: 'olas-cross-tab'`, and its entities plugin walks that write like any other. The peer's store follows, its reverse index binds the mirrored data, and its own `update` then reaches it. No entities traffic is needed. Pinned by "an app write that crosses is walked by the peer's entities plugin".
2. **An update every tab makes for itself would cross from every tab.** A realtime push reaches each tab, and each folds it into its own store. Opted in, each of N tabs sends its backprop and receives the other N−1, so every tab writes the entry a second time for nothing. With two tabs, the test counts two messages and two feed changes per tab, against none and one. Pinned by "opting in doubles the traffic when every tab makes the same update itself".
3. **Opting in works when it is wanted.** A patch from one tab's UI crosses as one message per affected entry, and the peer walks it into its store. There is no echo, because the peer applies it with cross-tab's own origin. Pinned by "with origins: [ENTITIES_PLUGIN_NAME] the patch crosses, and the peer walks it into its store".

The tests found no reason to change the default. "by default an entities.update patch stays in the tab that made it" pins it. `../decisions/plugin-host-v2.md` has the origin model this rests on.

Pinned by `plugin.test.ts`: "2. no echo", "11a. fetch-success writes are NOT broadcast", "14. writes another plugin or a tagged handle made are not mirrored", "15. optimistic: false mirrors only canonical writes", "3. crossTab: false queries stay isolated" and the three infinite-query cases. `coverage-edges.test.ts` pins that listing the plugin's own name in `origins` still sends nothing back.

## The receive side

The channel `listener` (`plugin.ts:231-253`) drops a non-object, another protocol version and its own echo silently. It hands every other message to `receive` (`plugin.ts:182-229`), which returns what became of it. Together they drop a message at the first check it fails:

1. a payload that is not an object, or a `v` other than `PROTOCOL_VERSION`;
2. its own `sourceId`, for a transport that echoes to the sender;
3. a `sourceId` that is not a string, or a `msgId` that is not a safe non-negative integer or is not above the last one seen from that peer. The per-peer cursors keep 64 peers and evict the oldest (`plugin.ts:138-151`).
4. a `queryId` that is not a string or `keyArgs` that is not an array, with an `onWarn`;
5. a query this root has not used or has not opted in (`accepts`, `plugin.ts:153-157`). `host.queries.get` knows only queries this root has bound, so the receive gate mirrors the send gate.

A `setData` message then also fails on a `pageParams` that is not an array, or on a `validate` that returns `false` or throws. It lands through `queries.write(queryId, keyArgs, () => data, { pageParams })` (`plugin.ts:211-220`), and an `invalidate` through `queries.invalidate` (`plugin.ts:222-226`).

Pinned by "10. out-of-order / duplicate messages are deduped", "13. receive-side filter — inbound writes for locally non-opted queries are ignored (T6.4)", and the `coverage-edges.test.ts` groups "inbound guards" and "per-peer cursor cap".

## Apply semantics: the entry must already exist

`host.queries.write` and `invalidate` address an entry by id and key, and do nothing when this root holds no entry for that key (`packages/core/src/query/client.ts:1024-1039`, `client.ts:943-955`). A message for a key no subscriber here has bound is therefore dropped. The receiver has no call args it could refetch that key with, and seeding rows the user never asked for leaks. A subscriber that mounts later fetches on its own.

A peer's write lands here as a canonical `'write'`, whatever its source was on the sender. A peer's optimistic value therefore holds no snapshot in this tab, and the peer's rollback arrives as one more write. A remote invalidate refetches a subscribed entry and marks an unsubscribed one stale (`client.ts:1465-1501`). Pinned by "1. setData in tab A is reflected in tab B" and "5. invalidation propagates → receiving tab refetches".

## Non-cloneable and oversized payloads

`BroadcastChannel` uses structured clone, so functions, class instances and symbols throw `DataCloneError` at `postMessage`. `send` catches it, calls `onWarn` and drops the broadcast (`plugin.ts:274-284`). The sender's cache is unaffected, because the write completed before the broadcast. Pinned by "6. non-cloneable data triggers onWarn; sender cache unaffected" and `non-cloneable.test.ts`.

Before posting, `send` estimates the size as the message's JSON length. Over `maxPayloadBytes` it warns and still posts (`plugin.ts:256-273`). `Infinity` turns the check off. Pinned by the `coverage-edges.test.ts` "outbound payload estimate" group.

## SSR no-op

`channelFactory` defaults to `defaultChannelFactory`, which returns `undefined` when `typeof BroadcastChannel === 'undefined'` (`packages/cross-tab/src/channel.ts:21-41`). `setup` then returns no hooks, because `factory(channelName)` gave it no channel (`plugin.ts:132-134`), and the root boots with cross-tab off. The root still needs a query engine, because the engine check comes first. Pinned by "7. SSR — channelFactory returning undefined yields a no-op plugin" and `ssr.test.ts`.

## Devtools lane (1.0)

A development build reports each message on the plugin's lane through `host.debug`:

- `send` reports every message it posts, after `postMessage` (`plugin.ts:285-295`). The `outcome` is `posted`, or `not-cloneable` when `postMessage` threw.
- The listener reports every message that reaches `receive`, with the outcome `receive` returned (`plugin.ts:238-252`): `applied`, `duplicate`, `malformed`, `ignored`, `rejected` or `failed`. The `Received` type lists them (`plugin.ts:71-80`).

```ts nocheck
{ kind: 'send', type: 'setData', queryId: 'app/user', outcome: 'posted', from: 'lq3k-7f2a', msgId: 4, key: ['user', 'me'] }
```

`from` is the message's `sourceId`, the sender's in both directions, so `from` and `msgId` name one message in the sender's lane and in each receiver's. The payload carries no `data`: the `cache:set-data` event on the core lane has it. A non-object, a message on another protocol version and the tab's own echo send no lane event. They are not traffic between peers on this protocol.

Both calls sit in `if (__DEV__)`, so the default build strips them. `host.debug` is a no-op in core's default build anyway (`packages/core/src/plugin/host.ts:166-169`). The plugin had no `__DEV__` code before 1.0, so it now ships a `development` build like entities (`packages/cross-tab/tsdown.config.ts`, `src/__dev__.d.ts`, `../decisions/esm-only-build.md`). Pinned by `tests/devtools-lane.test.ts`, which runs a send and receive pair on two roots, a failed post, and every receive outcome.

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

Any same-origin script can post on the channel. The listener ignores a `msgId` that is not a safe non-negative integer (`plugin.ts:185-189`), since `Number.MAX_VALUE` under a real peer's `sourceId` would silence that peer. It applies a message inside a try that reports to `onWarn` (`plugin.ts:159-172`). A key the engine cannot hash, such as a cycle, therefore does not throw out of the event handler. The `validate(queryId, data)` option rejects a payload shape the tab does not expect. Pinned by `tests/security.test.ts`; see `../decisions/trust-model.md`.
