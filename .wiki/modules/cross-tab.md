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
  - { type: tested-by, target: ../../packages/cross-tab/tests/channel.test.ts }
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
  channelFactory?: (name: string) => ChannelLike | undefined // default: a browser tab or worker only
  maxPayloadBytes?: number                               // soft cap, default 512 KB
  optimistic?: boolean                                   // mirror setData and rollbacks; default true
  origins?: readonly string[]                            // other write origins to mirror
  validate?: (queryId: string, data: unknown) => boolean // check a peer's payload
}): OlasPlugin
```

The options type is `CrossTabOptions` (`packages/cross-tab/src/plugin.ts:11-62`). The plugin's name is `CROSS_TAB_PLUGIN_NAME = 'olas-cross-tab'` (`plugin.ts:6`), and it is the `origin` of every write the plugin applies from a peer.

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

`index.ts:6-15` adds `crossTab?: boolean` to `QueryMeta` through `declare module`. `setup` throws without a query engine (`plugin.ts:131-138`), so `createRoot` fails before any channel opens. Pinned by `coverage-edges.test.ts`, "a root without a query engine fails to construct, before any channel opens".

## Message protocol

A discriminated union, versioned by `v` (`packages/cross-tab/src/protocol.ts:22-54`):

```ts nocheck
type Message =
  | { v: 1; type: 'setData'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[]; data: unknown; pageParams?: readonly unknown[] }
  | { v: 1; type: 'invalidate'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[] }
```

`PROTOCOL_VERSION = 1`. A receiver drops a message whose `v` it does not know. The app supplies the channel name, so an app that wants clean isolation across deploys embeds a version in it, such as `'app/cache/v2'`.

## What crosses: the send gate

`onWrite` and `onInvalidate` (`plugin.ts:336-364`) share one gate, `mirrors` (`plugin.ts:329-333`):

1. **Origin.** An event with `origin: undefined`, the app's own write, crosses. An origin named in `options.origins` crosses too. The plugin's own name never crosses, even when listed. This is the first echo layer: a write this tab applied from a peer carries `origin: 'olas-cross-tab'`, so it is not sent back. The same rule keeps out a write another plugin made. A realtime push reaches every tab by itself, so mirroring it would deliver it twice.
2. **Opt-in.** `event.query.meta.crossTab === true`, for a regular or an infinite query.
3. **Source.** `onWrite` drops `'fetch'` and `'hydrate'` (`plugin.ts:338`). Each tab runs its own fetcher and hydrates its own payload, so mirroring those would be N-tab noise that changes no cache. With `optimistic: false` it also drops `'optimistic'` and `'rollback'` (`mirrorOptimistic`, `plugin.ts:339-341`).

So by default `setData`, its rollback, `write` and `replace` cross. An infinite write carries its `pageParams` (`plugin.ts:350`). `onInvalidate` passes through the origin and opt-in gates only.

An `entities.update(...)` backprop carries `origin: 'olas-entities'`, so by default it stays in the tab that made it. An app that updates entities from one tab's UI lists `ENTITIES_PLUGIN_NAME` in `origins`, as the package README shows under "Whose writes cross".

### Decision: the entities origin stays opt-in (1.0)

The 1.0 backlog asked whether cross-tab should mirror the entities origin by default. It does not, for three reasons, each pinned by `packages/integration/tests/cross-tab-entities.test.ts`:

1. **A mirrored app write already reaches the peer's store.** The peer applies it with `origin: 'olas-cross-tab'`, and its entities plugin walks that write like any other. The peer's store follows, its reverse index binds the mirrored data, and its own `update` then reaches it. No entities traffic is needed. Pinned by "an app write that crosses is walked by the peer's entities plugin".
2. **An update every tab makes for itself would cross from every tab.** A realtime push reaches each tab, and each folds it into its own store. Opted in, each of N tabs sends its backprop and receives the other N−1, so every tab writes the entry a second time for nothing. With two tabs, the test counts two messages and two feed changes per tab, against none and one. Pinned by "opting in doubles the traffic when every tab makes the same update itself".
3. **Opting in works when it is wanted.** A patch from one tab's UI crosses as one message per affected entry, and the peer walks it into its store. There is no echo, because the peer applies it with cross-tab's own origin. Pinned by "with origins: [ENTITIES_PLUGIN_NAME] the patch crosses, and the peer walks it into its store".

The tests found no reason to change the default. "by default an entities.update patch stays in the tab that made it" pins it. `../decisions/plugin-host-v2.md` has the origin model this rests on.

Pinned by `plugin.test.ts`: "2. no echo", "11a. fetch-success writes are NOT broadcast", "14. writes another plugin or a tagged handle made are not mirrored", "15. optimistic: false mirrors only canonical writes", "3. crossTab: false queries stay isolated" and the three infinite-query cases. `coverage-edges.test.ts` pins that listing the plugin's own name in `origins` still sends nothing back.

## The receive side

The channel `listener` (`plugin.ts:261-283`) drops a non-object, another protocol version and its own echo silently. It hands every other message to `receive` (`plugin.ts:207-259`), which returns what became of it. Together they drop a message at the first check it fails:

1. a payload that is not an object, or a `v` other than `PROTOCOL_VERSION`;
2. its own `sourceId`, for a transport that echoes to the sender;
3. a `sourceId` that is not a string, or a `msgId` that is not a safe non-negative integer. A duplicate goes too: a `msgId` at or below the peer's cursor and less than `REORDER_WINDOW` (64) below it. The per-peer cursors keep 64 peers and evict the oldest (`MAX_PEERS`, `recordPeerMsg`, `plugin.ts:149-163`).
4. a `queryId` that is not a string or `keyArgs` that is not an array, with an `onWarn`;
5. a query this root has not used or has not opted in (`accepts`, `plugin.ts:165-169`). `host.queries.get` knows only queries this root has bound, so the receive gate mirrors the send gate.

A `setData` message then also fails on a `pageParams` that is not an array, or on a `validate` that returns `false` or throws. It lands through `queries.write(queryId, keyArgs, () => data, { pageParams })` (`plugin.ts:241-248`), and an `invalidate` through `queries.invalidate` (`plugin.ts:250-255`). Both go through `commit` (`plugin.ts:200-204`), which moves the peer's cursor only when the apply succeeded. See "Receiving untrusted messages" for why.

Pinned by "10. out-of-order / duplicate messages are deduped", "13. receive-side filter — inbound writes for locally non-opted queries are ignored (T6.4)", and the `coverage-edges.test.ts` groups "inbound guards" and "per-peer cursor cap".

## Apply semantics: the entry must already exist

`host.queries.write` and `invalidate` address an entry by id and key, and do nothing when this root holds no entry for that key (`packages/core/src/query/client.ts:1057-1072`, `client.ts:976-988`). A message for a key no subscriber here has bound is therefore dropped. The receiver has no call args it could refetch that key with, and seeding rows the user never asked for leaks. A subscriber that mounts later fetches on its own.

A peer's write lands here as a canonical `'write'`, whatever its source was on the sender. A peer's optimistic value therefore holds no snapshot in this tab, and the peer's rollback arrives as one more write. A remote invalidate refetches a subscribed entry and marks an unsubscribed one stale (`client.ts:1500-1536`). Pinned by "1. setData in tab A is reflected in tab B" and "5. invalidation propagates → receiving tab refetches".

## Non-cloneable and oversized payloads

`BroadcastChannel` uses structured clone, so functions, class instances and symbols throw `DataCloneError` at `postMessage`. `send` catches it, calls `onWarn` and drops the broadcast (`plugin.ts:304-314`). The sender's cache is unaffected, because the write completed before the broadcast. Pinned by "6. non-cloneable data triggers onWarn; sender cache unaffected" and `non-cloneable.test.ts`.

Before posting, `send` estimates the size as the message's JSON length. Over `maxPayloadBytes` it warns and still posts (`plugin.ts:286-303`). `Infinity` turns the check off. Pinned by the `coverage-edges.test.ts` "outbound payload estimate" group.

## Servers: no channel outside a browser

`channelFactory` defaults to `defaultChannelFactory` (`packages/cross-tab/src/channel.ts:44-64`). It opens a `BroadcastChannel` only when `isBrowserScope` (`channel.ts:24-35`) finds a browser. A browser tab or iframe has a `document`. A dedicated, shared or service worker has a global that is an instance of `WorkerGlobalScope`. It rules out Deno and Bun by name first, because their workers have a `WorkerGlobalScope` too. Everywhere else, and where `BroadcastChannel` is not defined, it returns `undefined`. `setup` then returns no hooks, because `factory(channelName)` gave it no channel (`plugin.ts:139-141`), and the root boots with cross-tab off. The root still needs a query engine, because the engine check comes first.

### Decision: why "has `BroadcastChannel`" was the wrong test (1.0 review)

Until the 1.0 review, the default checked only `typeof BroadcastChannel === 'undefined'`, and the docs said Node had no `BroadcastChannel`. Every Node version the package supports (`>=20.19`) has a global one. In Node it delivers to every channel of that name in the process, and across worker threads; Deno delivers across isolates. A server that builds a root per request therefore opened a real channel per request. Two request roots with `crossTabPlugin({ channelName: 'app/cache/v1' })` shared a bus, and Alice's `write` on `me` rendered in Bob's response.

The rule now asks for a browser scope instead of a channel constructor. A browser tab has a `document`. A web worker has none, but it may legitimately share a cache with the tabs of its origin, so a `WorkerGlobalScope` counts too. Node defines neither. Checking `window` alone would not do: Deno 1.x defined `window`. Checking `process.versions.node` would wrongly exclude an Electron renderer with Node integration, which has a document and real windows to sync. The known hole is a server that installs a global `document`, such as `global-jsdom`; the README tells it to pass `channelFactory: () => undefined`. An explicit `channelFactory` opens a channel anywhere, and `new BroadcastChannel(name)` fits `ChannelLike` as it is.

Pinned by `ssr.test.ts`: "Node has a global BroadcastChannel, and the default factory still opens none", "two request roots in one process never see each other's writes" (which failed on the old factory: Bob's root showed Alice's edit), "a Deno or Bun worker opens no channel either", "an explicit channelFactory opts in anywhere" and "a web worker scope with no document opens a channel". `channel.test.ts` runs under jsdom, whose `document` stands in for a tab. It pins the real round trip and the two-root sync. The sync test moved there from `coverage-edges.test.ts`, which ran under Node and relied on the leak. "7. SSR — channelFactory returning undefined yields a no-op plugin" pins the no-hooks path.

## Devtools lane (1.0)

A development build reports each message on the plugin's lane through `host.debug`:

- `send` reports every message it posts, after `postMessage` (`plugin.ts:315-325`). The `outcome` is `posted`, or `not-cloneable` when `postMessage` threw.
- The listener reports every message that reaches `receive`, with the outcome `receive` returned (`plugin.ts:268-282`): `applied`, `duplicate`, `malformed`, `ignored`, `rejected` or `failed`. The `Received` type lists them (`plugin.ts:74-84`).

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

Any same-origin script can post on the channel. The listener ignores a `msgId` that is not a safe non-negative integer (`Number.isSafeInteger`, `plugin.ts:213-220`). It applies a message inside a try that reports to `onWarn` (`applying`, `plugin.ts:171-184`). A key the engine cannot hash, such as a cycle, therefore does not throw out of the event handler. The `validate(queryId, data)` option rejects a payload shape the tab does not expect.

A forged high `msgId` under a real peer's `sourceId` used to silence that peer for good. The safe-integer check stopped `Number.MAX_VALUE`, but `receive` advanced the cursor before it validated the message, so `{ sourceId: 'peer-1', msgId: Number.MAX_SAFE_INTEGER }` with nothing else in it wedged peer-1 (1.0 review). Two changes close it:

- **The cursor moves only for a message this tab applied** (`commit`, `plugin.ts:200-204`). A malformed, ignored, rejected or failed message moves nothing.
- **A `msgId` far below the cursor restarts it** (`REORDER_WINDOW`, `plugin.ts:150-154`). A real peer's counter goes up by one per message, and `BroadcastChannel` neither reorders nor repeats, so a duplicate or a late delivery sits just below the cursor. A `msgId` 64 or more below it means the cursor is wrong: a forged well-formed message pushed it ahead. The receiver applies that message and restarts the cursor from it.

So the worst a forged message can do, beyond being applied itself, is hide up to 63 of the real peer's messages, when its `msgId` sits just above the real counter. A transport that redelivers a message more than 64 behind would get it applied again. Pinned by `tests/security.test.ts`, three of whose tests failed on the old code: "a malformed message with the highest safe msgId cannot silence the peer it claims", "a well-formed message with the highest safe msgId silences the peer only until it speaks", and "a message this tab ignores or rejects does not move the cursor". See `../decisions/trust-model.md`.
