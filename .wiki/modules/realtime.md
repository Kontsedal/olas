---
name: realtime
description: "@kontsedal/olas-realtime — useRealtimePatcher + useLiveStream over a consumer-supplied RealtimeService dep."
type: module
covers:
  - packages/realtime/src/index.ts
edges:
  - { type: documented-in, target: ../../SPEC.md }
  - { type: tested-by, target: ../../packages/realtime/tests/patcher.test.ts }
  - { type: tested-by, target: ../../packages/realtime/tests/live-stream.test.ts }
  - { type: uses, target: signals.md }
  - { type: uses, target: controller.md }
  - { type: related, target: persist.md }
last_verified: 2026-05-19
confidence: medium
---

# `@kontsedal/olas-realtime`

Two thin composables over a consumer-supplied `RealtimeService` (`ctx.deps.realtime`):

- `useRealtimePatcher(ctx, channel, handlers)` — subscribe, dispatch each event to a type-keyed handler. Wraps SPEC §16.5 lines 1364-1391.
- `useLiveStream<TEvent>(ctx, channel, options?)` — tail-mode buffer with `capacity` + coalesced `flushMs` flushes, plus pause/resume/clear. Wraps SPEC §16.5 lines 1547-1597.

The package ships **no default transport** — apps inject their own (WebSocket / Pusher / Ably / Supabase / SSE) through deps.

## API

| Name | Signature | Notes |
|---|---|---|
| `useRealtimePatcher<TEvent>` | `(ctx, channel, handlers) => void` | Handlers run inside `untracked(...)` so accidental signal reads don't add deps to the surrounding effect. |
| `useLiveStream<TEvent>` | `(ctx, channel, options?) => LiveStream<TEvent>` | `LiveStream = { events: ReadSignal<readonly TEvent[]>, isPaused: ReadSignal<boolean>, pause, resume, clear }` |
| `RealtimeService` | `{ subscribe(channel, handler): { unsubscribe(): void } }` | Object form (not bare function) so it matches §16.5's example shape. |
| `RealtimeDeps` | `{ realtime: RealtimeService }` | Slice of `ctx.deps` consumed by this package. |

## `RealtimeService` contract + `AmbientDeps` augmentation

```ts
type RealtimeSubscription = { unsubscribe(): void }
type RealtimeService = {
  subscribe<TEvent = unknown>(
    channel: string,
    handler: (event: TEvent) => void,
  ): RealtimeSubscription
}

// In the app's top-level types:
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}
```

After augmentation, `Ctx<AmbientDeps>` satisfies the `Ctx<RealtimeDeps>` parameter shape, so user controllers can pass their bare `ctx` straight through.

## Lifecycle

Both composables hold their subscription inside `ctx.effect(() => { ... return () => sub.unsubscribe() })`:

- **Dispose**: effect cleanup unsubscribes; `useLiveStream` also `clearTimeout`s any pending flush. See `packages/realtime/src/index.ts:158-164`.
- **Pause / resume**: `useLiveStream` reads `isPaused.value` at the top of the effect. The signal write triggered by `pause()` causes the effect to re-run with `isPaused === true`, which short-circuits before subscribing — the previous run's cleanup runs first and unsubscribes. `resume()` flips it back, the effect runs again, and a fresh subscription is established.
- **Pending preserved across pause**: the `pending: TEvent[]` accumulator is not cleared on pause. Events buffered in the same tick a pause is requested still flush eventually (or when the next subscription delivers a new event and triggers another flush). One-line comment in source documents this.

## Tail-buffer semantics

- **Capacity** is oldest-drop. The flush computes `next = events.peek().concat(pending).slice(-capacity)` — `slice`, not `splice`, because signals need a fresh array reference for subscribers to fire.
- **`flushMs`** coalesces bursts. A single timer is scheduled on first enqueue; further enqueues just push onto `pending` until the timer fires.
- **`flushMs <= 0`** flushes synchronously per event. Used by the capacity test to skip the timer.
- **`clear()`** empties both `events` and `pending`, and `clearTimeout`s any pending flush. The subscription itself is **not** torn down — calling `clear()` while live is the natural "start fresh, keep streaming" idiom.

## Why `untracked` wraps the patcher handler

If a handler reads `someQuery.data.value` to compute a patch, that read would otherwise register as a dep of the surrounding `ctx.effect`. The next signal mutation would dispose+re-subscribe — silent thrash. Wrapping in `untracked(...)` neutralizes this. There's an explicit test for it (`patcher.test.ts` — "handlers are wrapped in untracked").

## Out of scope (v1)

Tracked in `BACKLOG.md`:

- Multi-channel patcher sugar (today: call `useRealtimePatcher` per channel).
- Backpressure beyond `capacity` + `flushMs` (sampling, downsampling, priority queues).
- A default transport. Bring your own; the package is a behavior wrapper, not a transport.

## Where to read next

- `packages/realtime/src/index.ts` — 180 lines, the whole package.
- `packages/realtime/tests/patcher.test.ts` and `live-stream.test.ts` — 10 tests pinning the behaviors above.
- SPEC §16.5 (lines 1364-1391 for the patcher pattern; 1547-1597 for tail-buffer).
- `modules/persist.md` — the closest sibling: same "tiny wrapper around a `ctx.effect` + `ctx.deps.<service>` recipe" shape.
