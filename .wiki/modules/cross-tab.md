---
name: cross-tab
description: "@kontsedal/olas-cross-tab — BroadcastChannel-based in-memory query cache sync across tabs of the same origin."
type: module
covers:
  - packages/cross-tab/src/index.ts
  - packages/cross-tab/src/plugin.ts
  - packages/cross-tab/src/protocol.ts
  - packages/cross-tab/src/channel.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/cross-tab/tests/plugin.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/ssr.test.ts }
  - { type: tested-by, target: ../../packages/cross-tab/tests/non-cloneable.test.ts }
  - { type: uses, target: query.md }
  - { type: uses, target: ../entities/query-client.md }
  - { type: related, target: persist.md }
last_verified: 2026-05-22
confidence: medium
---

# `@kontsedal/olas-cross-tab`

Single composable: `crossTabPlugin(options)` — a `QueryClientPlugin` (§13.2) that broadcasts every `setData` and `invalidate` for `crossTab: true` queries over a `BroadcastChannel`, and replays inbound messages back through the local `QueryClient`. Spec §13.2.

## API

```ts
crossTabPlugin({
  channelName: string                                // required
  onWarn?: (message: string, cause?: unknown) => void
  channelFactory?: (name: string) => ChannelLike | undefined
}): QueryClientPlugin
```

Wire into `RootOptions.plugins`:

```ts
createRoot(appController, {
  deps,
  plugins: [crossTabPlugin({ channelName: 'app/cache/v1' })],
})
```

Per-query opt-in:

```ts
defineQuery({
  queryId: 'app/user/v1',   // required for cross-tab routing
  crossTab: true,           // per-query gate
  key, fetcher, ...
})
```

## Message protocol

Discriminated union, versioned by `v`. See `packages/cross-tab/src/protocol.ts`.

```ts
type Message =
  | { v: 1; type: 'setData'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[]; data: unknown }
  | { v: 1; type: 'invalidate'; sourceId: string; msgId: number; queryId: string; keyArgs: readonly unknown[] }
```

`PROTOCOL_VERSION = 1`. Receivers drop messages whose `v` they don't understand. Channel names themselves are user-supplied — embed a version (e.g. `'app/cache/v2'`) in the name for clean cross-deploy isolation.

## Echo prevention — three layers + source filter

1. **Sender-side, in core.** `QueryClient.applyRemoteSetData(...)` flips an internal `applyingRemote` flag while applying an inbound write. The resulting plugin `SetDataEvent` carries `isRemote: true`. The cross-tab plugin's `onSetData` returns early in that case — no rebroadcast. (`packages/core/src/query/client.ts` — `applyRemoteSetData`, `applyRemoteInvalidate`, `emitSetData`.)
2. **Own-source drop.** Each plugin instance picks a random `sourceId` at construction. Receivers ignore messages with their own `sourceId` — catches transports that echo back to the sender's listeners.
3. **`(sourceId, msgId)` dedup.** Senders use a monotonic per-source `msgId` counter. Receivers track `last seen msgId` per peer in a `Map<sourceId, number>` and drop messages with `msgId <= last`. This handles both duplicates and out-of-order delivery.

In addition, `onSetData` skips events with `source: 'fetch'`. `SetDataEvent` carries `source: 'set' | 'fetch' | 'remote'` so layered plugins can distinguish explicit `setData` calls from fetcher-result writes. Cross-tab broadcasts only `source: 'set'` — every tab runs its own fetcher and rebroadcasting fetch results would be N-tab quadratic noise that doesn't change anyone's cache. See `packages/cross-tab/src/plugin.ts:161-165` (the `if (event.source === 'fetch') return` gate inside `onSetData`) and the regression test at `tests/plugin.test.ts` (`'11a. fetch-success writes are NOT broadcast'`).

## Per-query opt-in via `queryId`

The `QueryClient` fires plugin events for every query that has a `queryId` set, regardless of `crossTab`. The cross-tab plugin checks `crossTab === true` on the spec via the `lookupRegisteredQuery(queryId)` helper before broadcasting. Two consequences:

- A query without a `queryId` is invisible to the plugin (`emitSetData` in core skips firing). `crossTab: true` without a `queryId` warns once (dev only) at `defineQuery` time.
- A query with `queryId` but `crossTab: false` (or undefined) is also skipped — useful for staging changes before flipping on the gate.

## Apply semantics — entries must already exist

`QueryClient.applyRemoteSetData(queryId, keyArgs, data)` only writes if a local entry exists for that key (matched by `stableHash(keyArgs)`). Otherwise the message is dropped silently. Rationale: without `callArgs`, the receiving tab couldn't refetch the entry later — and seeding cache rows the user never subscribed to is leaky. Subscribers that mount AFTER a message has been dropped get the default fetcher path; they don't need the dropped message to converge.

## Non-cloneable values

`BroadcastChannel` uses structured clone. Functions, class instances, symbols all throw `DataCloneError` at `postMessage`. The plugin wraps every send in try/catch, calls `onWarn(...)` with a descriptive message, and drops the broadcast. **The sender's cache is unaffected** — the cache write completed before the broadcast attempt.

## SSR no-op

`channelFactory` defaults to `defaultChannelFactory`, which returns `undefined` when `typeof BroadcastChannel === 'undefined'`. In that case `crossTabPlugin(...)` returns an empty plugin object (`{}`) — every hook is undefined, so the QueryClient's `try/catch`-wrapped dispatch is a no-op. Roots boot cleanly in Node / SSR contexts; cross-tab is just disabled.

## Interaction with `@kontsedal/olas-persist`

Both layers sync state between tabs but at different levels:

- `@kontsedal/olas-persist` mirrors **durable** state via `localStorage` + the `storage` event.
- `@kontsedal/olas-cross-tab` mirrors the **in-memory** query cache via `BroadcastChannel`.

Layering them on the same logical state is supported but redundant. Persist already handles cross-tab via the storage event; this plugin is for the much larger query cache that doesn't touch disk.

## Module-graph caveat (test harness)

In real life each tab is its own process with its own `defineQuery` invocation, so `Query.__clients` only contains the local client. In a single-process test, two `createRoot(...)` calls share one `defineQuery` value, and `Query.setData(...)` writes to BOTH clients synchronously — masking the cross-tab path. The test harness in `packages/cross-tab/tests/plugin.test.ts` mints separate `defineQuery({ queryId: '...' })` values per "tab" so each tab has its own `__clients` set. The registry's "last write wins" semantics mean the most-recent definition is the routing target — fine because every tab's `applyRemoteSetData` only applies if the LOCAL `QueryClient` has an entry for the key, and each tab's local entries are bound against its own query value.

## Limitations (v1)

- **No infinite queries.** `defineInfiniteQuery` writes fire plugin events with `kind: 'infinite'` for forward compatibility, but the cross-tab plugin filters them out — page-array payloads are too heavy to be a safe default.
- **No structural diffs.** Every `setData` broadcasts the full post-update value. Fine for `BroadcastChannel` (in-memory); known cost for very large entries.
- **Optimistic writes cross tabs.** All `setData` events broadcast regardless of cause, so optimistic state (and rollback) is visible cross-tab. Mitigate by skipping cross-tab for optimistic-heavy queries (set `crossTab: false`, or use a `LocalCache` instead of a `Query`).
- **Pending-mutation arbitration is local.** Concurrent optimistic mutations on the same entry in two tabs follow last-write-wins on both sides; the mutation's settle/rollback path then re-syncs the truth.
