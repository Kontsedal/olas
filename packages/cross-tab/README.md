# @kontsedal/olas-cross-tab

`BroadcastChannel`-backed cache sync for `@kontsedal/olas-core`. When the app in one tab writes to a query or invalidates it, every other tab of the same origin sees the same change. No tab re-fetches, nothing touches storage, and no request reaches the server. SPEC §13.2.

This is the **in-memory** sibling to `@kontsedal/olas-persist`. Persistence mirrors *durable* state on the `storage` event; this mirrors the (much larger) in-memory query cache that never touches disk. Both are independently opt-in.

## Install

```bash
pnpm add @kontsedal/olas-cross-tab @kontsedal/olas-core @preact/signals-core
```

## 30-second example

```ts
import {
  bindQuery,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'

type User = { id: string; name: string }

// Opt the query in. Its `id` routes messages between tabs, so it must be
// the same in every tab's build.
const userQuery = defineQuery({
  id: 'app/user',
  key: (id: string) => ['user', id],
  fetcher: ({ signal }, id: string) =>
    fetch(`/api/user/${id}`, { signal }).then((r) => r.json() as Promise<User>),
  meta: { crossTab: true },
})

const appController = defineController((ctx) => ({
  user: createQuery(ctx, userQuery, () => ['me']),
  users: bindQuery(ctx, userQuery),
}))

const root = createRoot(appController, {
  queries: queryEngine(),
  deps: {},
  plugins: [crossTabPlugin({ channelName: 'my-app/cache/v1' })],
})

// Tab A:
root.api.users.write('me', (prev) => ({ id: 'me', ...prev, name: 'New' }))
```

Tab B's subscribers see the new value on the next signal flush. No fetch fires in Tab B.

## API

```ts nocheck
function crossTabPlugin(options: CrossTabOptions): OlasPlugin

type CrossTabOptions = {
  channelName: string
  onWarn?: (message: string, cause?: unknown) => void
  channelFactory?: (name: string) => ChannelLike | undefined
  maxPayloadBytes?: number
  optimistic?: boolean
  origins?: readonly string[]
  validate?: (queryId: string, data: unknown) => boolean
}
```

| Option | Default | What |
|---|---|---|
| `channelName` | required | Name of the `BroadcastChannel`. Include a version suffix (`my-app/v2`) for clean cross-deploy isolation — receivers from a different deploy with a different channel name simply don't see each other's traffic. |
| `onWarn` | `console.warn` | Called on non-fatal conditions: `DataCloneError` while broadcasting (the data isn't structured-cloneable), an oversized payload, a malformed inbound message, or one `validate` rejected. |
| `channelFactory` | `defaultChannelFactory` (wraps `BroadcastChannel`) | Override the channel constructor. Mainly for tests. Return `undefined` to disable cross-tab (the plugin installs no hooks). |
| `maxPayloadBytes` | `512 * 1024` | Soft cap on one outbound message, estimated by its JSON length. Over the cap, the plugin warns and still posts. `Infinity` turns the warning off. |
| `optimistic` | `true` | Also mirror optimistic `setData` writes and their rollbacks, so peers show a pending edit before the server confirms it. With `false`, only canonical writes and invalidations cross. |
| `origins` | `[]` | Origins whose writes and invalidations are mirrored too: a plugin's name, or the `origin` a `bindQuery` handle was given. See [Whose writes cross](#whose-writes-cross). |
| `validate` | accept every payload | Check a peer's data before this tab writes it. Return `false` to drop the message, which is reported through `onWarn`. A `validate` that throws rejects the message. |

The plugin needs a query engine. A root created without `queries: queryEngine()` throws at `createRoot`, before any channel opens.

## How it works

The plugin's `onWrite` and `onInvalidate` hooks post each mirrored change onto a `BroadcastChannel`. A receiving tab applies it through its own `host.queries.write` or `host.queries.invalidate`. That write carries the plugin's name, `'olas-cross-tab'`, as its `origin`. The send gate skips a write with that origin, so nothing echoes back.

```
Tab A: users.write(...) → cache write (origin: undefined) → plugin onWrite
                                                                 ↓
                                                        channel.postMessage(msg)
                                                                 ↓
                        ━━━━━━━━━━━━━━━━━━━━━ BroadcastChannel ━━━━━━━━━━━━━━━━━━━━━
                                                                 ↓
Tab B: channel listener → validate(queryId, data) → host.queries.write(...)
       cache write (origin: 'olas-cross-tab') → plugin onWrite → not mirrored
```

### What crosses

| Change | Crosses? |
|---|---|
| `write` and `replace` (canonical) | Yes |
| `setData` (optimistic) and its rollback | Yes, unless `optimistic: false` |
| `invalidate` | Yes. The receiving tab marks the entry stale, and refetches it only if it has subscribers. |
| A fetch result | No. Every tab runs its own fetcher, so rebroadcasting results would be noise that changes nobody's cache. |
| Hydration | No. It is a per-tab concern too. |

A receiving tab applies a write only to an entry it already holds for that key, and creates no new entries. A subscriber that mounts later fetches as usual.

### Whose writes cross

By default the plugin mirrors only the app's own writes: those whose `origin` is `undefined`. A write with an `origin` came from another plugin, or from a handle made with `bindQuery(ctx, query, { origin })`. Such a write is usually derived. A realtime push reaches every tab itself, so mirroring it would deliver it twice.

List an origin in `origins` to mirror its writes too. The entities plugin is the usual case: an `entities.update(...)` patch stays in its own tab until you opt in.

The entities default is opt-in for two reasons:

- An app write that crosses already reaches the peer's store. The peer's own entities plugin walks the mirrored write, as it walks any other write.
- An update that every tab makes for itself, such as one realtime push each tab folds into its store, would cross from every tab. With two tabs that is two messages and a second, redundant write in each tab, where the default sends none.

Opt in when one tab's UI makes the update and the other tabs have no other way to learn it.

```ts
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { ENTITIES_PLUGIN_NAME } from '@kontsedal/olas-entities'

const crossTab = crossTabPlugin({
  channelName: 'my-app/cache/v1',
  origins: [ENTITIES_PLUGIN_NAME],
})
```

A write the plugin applied from a peer is not mirrored back, even with the plugin's own name in `origins`.

### Echo prevention (three layers)

1. **Origin:** a write the plugin applied from a peer carries `origin: 'olas-cross-tab'`, and the send side skips it.
2. **Own-source drop:** receivers filter messages by `sourceId`. Every root picks a random one when the plugin sets up. If the transport echoes the message back, the sender ignores it.
3. **`(sourceId, msgId)` dedup:** monotonic `msgId` per `sourceId` lets receivers drop out-of-order or duplicate messages.

### Protocol versioning

Messages carry `v: PROTOCOL_VERSION`. Receivers drop messages with a `v` they don't understand. Channel names themselves are user-supplied; for cross-deploy isolation, embed a version in your `channelName` (e.g. `'app/cache/v2'`).

### Non-cloneable data

`BroadcastChannel` uses structured clone. Cache data containing a function or a symbol throws `DataCloneError` at `postMessage`. A class instance does not throw; it arrives as a plain object without its prototype. The plugin catches the throw, calls `onWarn(...)`, and drops the message. **The sender's cache is unaffected** — only the cross-tab echo is lost.

### Messages from other scripts

Any same-origin script can post on the channel, so a receiving tab treats a message as possibly corrupt (SPEC §22):

- It drops a message whose protocol version, `sourceId` or `msgId` is wrong. A `msgId` has to be a safe non-negative integer, so a planted `Number.MAX_VALUE` cannot silence a real peer.
- It warns about a message with a bad `queryId`, `keyArgs` or `pageParams`, and does not apply it.
- It reports a message it cannot apply, such as a key the engine cannot hash, through `onWarn`. Nothing throws out of the channel's handler.
- It passes each payload to `validate`, when one is given.

Olas does not check that a peer's data matches the query's type. `validate` and a versioned `channelName` are the tools for that:

```ts
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'

const crossTab = crossTabPlugin({
  channelName: 'my-app/cache/v1',
  validate: (queryId, data) =>
    queryId !== 'app/user' ||
    (typeof data === 'object' && data !== null && typeof (data as { name?: unknown }).name === 'string'),
})
```

## Devtools

In a development build, the plugin reports every message on its lane in `@kontsedal/olas-devtools`, through `host.debug`. A tab reports each message it posts, and each message a peer sent on this protocol version:

```ts nocheck
{ kind: 'send', type: 'setData', queryId: 'app/user', outcome: 'posted', from: 'lq3k-7f2a', msgId: 4, key: ['user', 'me'] }
{ kind: 'receive', type: 'setData', queryId: 'app/user', outcome: 'applied', from: 'lq3k-7f2a', msgId: 4, key: ['user', 'me'] }
```

`from` is the sending root's `sourceId`, so `from` and `msgId` name one message in the sender's lane and in every receiver's.

| `outcome` | Meaning |
|---|---|
| `posted` | Sent. |
| `not-cloneable` | `postMessage` threw, and the message was dropped. |
| `applied` | Written or invalidated in this tab. |
| `duplicate` | Its `msgId` is not above the last one this tab saw from that peer. |
| `malformed` | A field has the wrong shape, or the message type is unknown. |
| `ignored` | This tab has not bound the query, or has not opted it in. |
| `rejected` | `validate` returned `false` or threw. |
| `failed` | Applying it threw, such as on a key the engine cannot hash. |

A payload that is not an object, a message on another protocol version, and a tab's own echoed message are dropped without a lane event. The default build strips the calls.

## Per-query opt-in

Two fields on the definition gate cross-tab behavior:

- **`id: string`** — required on every `defineQuery` and `defineInfiniteQuery`. Messages route by it, so keep it stable and identical across tabs and deploys. Write it by hand: a name derived from `fetcher.name` changes under minification.
- **`meta: { crossTab: true }`** — the per-query gate. The package adds `crossTab` to core's `QueryMeta` type. Without it, the plugin doesn't broadcast, so module-internal queries don't leak. The gate applies on **both** send and receive. A tab ignores inbound writes for queries its own build didn't opt in, so an opt-in mismatch across deploys can't push writes into unmarked queries.

Infinite queries opt in the same way. Their pages travel with their `pageParams`, so the receiving tab keeps paging from them. Page arrays can be large, and `maxPayloadBytes` warns about them.

## SSR

When `BroadcastChannel === undefined` (Node, older browsers) and no `channelFactory` override is supplied, the plugin installs no hooks. The root still constructs cleanly; cross-tab is disabled. This means you can wire the plugin unconditionally in shared code paths.

## Interaction with `@kontsedal/olas-persist`

These two layers solve different problems:

- `@kontsedal/olas-persist` mirrors **durable** state via `localStorage` + the `storage` event.
- `@kontsedal/olas-cross-tab` mirrors the **in-memory** query cache via `BroadcastChannel`.

You can combine them on the same logical entity, but it's redundant — `@kontsedal/olas-persist`'s cross-tab sync already covers the durable copy.

## Conflict model — last-delivery-wins

Cross-tab sync is a broadcast, not a consensus protocol — think of it as "every tab refetched, but for free," not as a source of truth. There's no arbitration, no vector clocks, no server round-trip: each tab applies inbound writes in delivery order, and the last delivery wins for that tab. So two tabs that write the *same* entry concurrently can settle on different values until something reconciles them.

That something is a server refetch, and it's a one-liner: after a write that matters, call `query.invalidate(...)` (it broadcasts too), and every tab pulls authoritative server truth and re-converges. The mutation `onError` and `onSuccess` → invalidate pattern gives you this for free.

## Limitations

- **No structural diffs.** Every write broadcasts the full post-update value. For chunky cache entries this is fine because `BroadcastChannel` is in-memory; for very large arrays it's a known cost.
- **No pending-mutation arbitration.** If two tabs run optimistic mutations on the same entry concurrently, the last write to arrive wins on both sides. Your mutation `onError` and `onSuccess` then re-syncs from the server, which restores convergence at the cost of a temporary divergence.
- **Optimistic writes cross tabs by default.** Optimistic state and its rollback are visible in other tabs. Pass `optimistic: false` to keep them local.

## Further reading

- [`../../.wiki/modules/cross-tab.md`](../../.wiki/modules/cross-tab.md)
- [SPEC §13.2](../../SPEC.md#132-cross-tab-in-memory-cache-sync) — Cross-tab in-memory cache sync.
- [SPEC §5.2](../../SPEC.md#52-query-definition) — Query definition (`id`, `meta`).
- [SPEC §20.8](../../SPEC.md#208-root--options) — `RootOptions.plugins`.
- SPEC §22 — the trust model for channel messages.
