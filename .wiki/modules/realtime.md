---
name: realtime
description: "@kontsedal/olas-realtime — createRealtimePatcher + createLiveStream over a consumer-supplied RealtimeService dep; channels as signals, one shared connection listener per transport."
type: module
covers:
  - packages/realtime/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/realtime/tests/patcher.test.ts }
  - { type: tested-by, target: ../../packages/realtime/tests/live-stream.test.ts }
  - { type: tested-by, target: ../../packages/realtime/tests/channel-signal.test.ts }
  - { type: tested-by, target: ../../packages/realtime/tests/shared-connection.test.ts }
  - { type: tested-by, target: ../../packages/realtime/tests/handlers.test-d.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: controller.md }
  - { type: related, target: persist.md }
last_verified: 2026-09-25
confidence: medium
---

# `@kontsedal/olas-realtime`

Two thin composables over a consumer-supplied `RealtimeService` (`ctx.deps.realtime`):

- `createRealtimePatcher(ctx, channel, handlers)` — subscribe, dispatch each event to a type-keyed handler. SPEC §16.5 "Real-time updates → cache patches".
- `createLiveStream<TEvent>(ctx, channel, options?)` — tail-mode buffer with `capacity` + coalesced `flushMs` flushes, plus pause/resume/clear. SPEC §16.5 "Live streaming buffers".
- `createConnectionState(ctx)` and `onReconnect(ctx, fn)` — connection-state signal + reconnect trigger (see "Connection state" below).

The package ships **no default transport** — apps inject their own (WebSocket, Pusher, Ably, Supabase and SSE) through deps.

## API

| Name | Signature | Notes |
|---|---|---|
| `createRealtimePatcher<TEvent>` | `(ctx, channel: string \| ReadSignal<string>, handlers) => void` | Handlers run inside `untracked(...)` so accidental signal reads don't add deps to the surrounding effect. |
| `PatcherHandlers<TEvent>` | `{ [K in TEvent['type']]?: (ev: Extract<TEvent, { type: K }>) => void } & { '*'?: (ev: TEvent) => void }` | Each handler gets its own variant; `'*'` gets the union. |
| `createLiveStream<TEvent>` | `(ctx, channel: string \| ReadSignal<string>, options?) => LiveStream<TEvent>` | `LiveStream = { events: ReadSignal<readonly TEvent[]>, isPaused: ReadSignal<boolean>, pause, resume, clear }` |
| `RealtimeService` | `{ subscribe(channel, handler): { unsubscribe(): void }, onConnectionChange?(handler): () => void }` | Object form (not bare function) so it matches §16.5's example shape. |
| `RealtimeDeps` | `{ realtime: RealtimeService }` | Slice of `ctx.deps` consumed by this package. |

## `RealtimeService` contract + `AmbientDeps` augmentation

```ts nocheck
type RealtimeSubscription = { unsubscribe(): void }
type RealtimeService = {
  subscribe<TEvent = unknown>(
    channel: string,
    handler: (event: TEvent) => void,
  ): RealtimeSubscription
  // Optional — powers createConnectionState / onReconnect. Absent → 'unknown'.
  onConnectionChange?(handler: (state: ConnectionState) => void): () => void
}

// In the app's top-level types:
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}
```

After augmentation, `Ctx<AmbientDeps>` satisfies the `Ctx<RealtimeDeps>` parameter shape, so user controllers can pass their bare `ctx` straight through.

## Handler typing

`PatcherHandlers<TEvent>` (`index.ts:77-81`) maps each `TEvent['type']` to a handler of `Extract<TEvent, { type: K }>`, so `'comment-added': (ev) => ev.comment` compiles with no narrowing. Before 1.0 every handler received the whole union, and RECIPES and the kanban board cast around it. A handler annotated with the whole union still fits a key, since a parameter is contravariant. A key outside the union is an excess-property error. The dispatcher itself still sees the union, so `createRealtimePatcher` casts the looked-up handler to `(e: TEvent) => void` in one place (`index.ts:112`). `tests/handlers.test-d.ts` pins all of it, and `tsc` checks that file; vitest does not run it.

## Channels as signals

`channel` is a name or a `ReadSignal<string>`. `channelName` (`index.ts:84-85`) reads a signal's `.value` inside the owning `ctx.effect`, so the signal is a tracked dependency:

- **Patcher** (`index.ts:104-122`). A new name re-runs the effect: the cleanup unsubscribes from the old channel and the body subscribes to the new one. A write of the same name does not notify, so nothing resubscribes. A per-route room is a `computed` over the route params.
- **Live stream** (`index.ts:299-322`). The effect reads the channel *before* `isPaused`, so a change re-runs it during a pause too. `bufferedFrom` records the channel the buffered events came from. A new name empties `events` and `pending` through the same `clear()` the api returns. The reason is that a tail holds one channel's events, and nothing in an event says which channel it came from. Pause and resume on one channel keep the buffer.

## Lifecycle

Both composables hold their subscription inside `ctx.effect(() => { ... return () => sub.unsubscribe() })`:

- **Dispose**: effect cleanup unsubscribes; `createLiveStream` also cancels any pending flush (`cancelFlush`).
- **Pause and resume**: `createLiveStream` reads `isPaused.value` in the effect. The signal write triggered by `pause()` causes the effect to re-run with `isPaused === true`, which returns before subscribing — the previous run's cleanup runs first and unsubscribes. `resume()` flips it back, the effect runs again, and a fresh subscription is established.
- **Events during pause are LOST** (T6.7): `pause()` tears down the subscription, so nothing is received while paused — only *already-buffered* events survive. The `pending: TEvent[]` accumulator isn't cleared on pause (events buffered in the same tick as the pause still flush), but a genuine gap can't be recovered from the buffer — pair with `onReconnect(...)` + query `invalidate` to refetch authoritative state. The docstrings + README say this explicitly.

## Connection state (`createConnectionState` / `onReconnect`)

`createConnectionState(ctx): ReadSignal<ConnectionState>` where `ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'unknown'`, backed by the optional `RealtimeService.onConnectionChange?(handler): () => void`. With a reporter it starts optimistically at `'connected'` and tracks changes; **without one it reports `'unknown'`** — the hook can't observe state, so it says so rather than lying `'connected'` (T6.7). `onReconnect(ctx, fn)` fires `fn` on a transition back to `'connected'` (not on the initial value), the canonical "invalidate queries that missed updates during the disconnect" trigger.

**One transport listener per `RealtimeService`.** `onReconnect` builds on `createConnectionState`, so a controller with both used to open two `onConnectionChange` subscriptions, and N controllers opened N. Now `joinConnection` (`index.ts:389-426`) keeps a hub per service in a `WeakMap`:

- Each `createConnectionState` keeps its own signal and joins the hub from its `ctx.effect`. The effect's cleanup leaves it, so dispose and suspend leave, and resume joins again.
- The first listener opens the subscription before it adds itself, and the hub fans every report out to all listeners inside one `batch`. The last listener to leave closes it.
- `last` holds the latest report while the subscription is open. A listener that joins an open subscription starts from it, because the transport's synchronous "current state" call, if it makes one, went to the first listener only. A listener that joins before any report stays at `'connected'`.
- Closing the subscription forgets `last`. The next listener opens a new one and starts optimistic, as each `createConnectionState` did before the hub.
- A throwing `onConnectionChange` throws before the listener is added, so the hub stays closed and empty. The error reaches `onError` through `ctx.effect`, and the next listener opens the subscription again.

The hub calls `onConnectionChange` with the service as `this`. The old code read the method off the service and called it bare, so a class-based transport threw `Cannot read properties of undefined` on its first `this.` access. `shared-connection.test.ts` pins that with a class, and it failed against the old code.

Why reuse is allowed: the transport contract is a plain listener, `onConnectionChange(handler) => off`, with every change delivered to every listener. The one thing a second listener would get that a shared one does not is the synchronous "current state" call, and `last` stands in for it.

## Tail-buffer semantics

- **Capacity** is oldest-drop. The flush computes `merged = events.peek().concat(pending)` and sets `merged.slice(dropCount)` — `slice`, not `splice`, because signals need a fresh array reference for subscribers to fire.
- **`flushMs`** coalesces bursts. A single timer is scheduled on first enqueue; further enqueues only push onto `pending` until the timer fires.
- **`flushMs <= 0`** flushes synchronously per event. Used by the capacity test to skip the timer.
- **`clear()`** empties both `events` and `pending`, and cancels any pending flush. The subscription itself is **not** torn down — calling `clear()` while live is the natural "start fresh, keep streaming" idiom. A channel change calls the same function.

## Why `untracked` wraps the patcher handler

If a handler reads `someQuery.data.value` to compute a patch, that read would otherwise register as a dep of the surrounding `ctx.effect`. The next signal mutation would dispose+re-subscribe — silent thrash. Wrapping in `untracked(...)` neutralizes this. There's an explicit test for it (`patcher.test.ts` — "handlers are wrapped in untracked"), and one with a channel signal (`channel-signal.test.ts`).

## Out of scope (v1)

- Multi-channel patcher sugar (today: call `createRealtimePatcher` per channel).
- Backpressure beyond `capacity` + `flushMs` (sampling, downsampling, priority queues).
- A default transport. Bring your own; the package is a behavior wrapper, not a transport.

## Where to read next

- `packages/realtime/src/index.ts` — the whole package, one file.
- `packages/realtime/tests/` — `patcher`, `live-stream` and the two `coverage-*` files pin the base behaviour. `channel-signal` pins channels as signals, `shared-connection` the one listener per transport, and `handlers.test-d.ts` the handler types. `fake-realtime.ts` is the in-memory transport the two newer files share.
- SPEC §16.5 "Real-time updates → cache patches" and "Live streaming buffers".
- `modules/persist.md` — the closest sibling: same "tiny wrapper around a `ctx.effect` + `ctx.deps.<service>` recipe" shape.
