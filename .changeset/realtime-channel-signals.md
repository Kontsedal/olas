---
"@kontsedal/olas-realtime": minor
---

**Channels can be signals, each patcher handler gets its own event type, and one transport listener serves every connection-state user.**

- **`channel` takes a `ReadSignal<string>`.** `createRealtimePatcher` and `createLiveStream` accept `string | ReadSignal<string>`. When the signal changes, they unsubscribe from the old channel and subscribe to the new one. So a controller can follow a per-route room, `computed(() => 'room:' + params.value.roomId)`, without being rebuilt. A live stream also empties its buffer on the change, as `clear()` does, because the buffered events came from the old channel. A change during a pause empties it too, and `resume()` subscribes to the new name.
- **Each handler receives its own variant.** `PatcherHandlers<TEvent>` types the handler for `'comment-added'` as `(ev: Extract<TEvent, { type: 'comment-added' }>) => void`, so it reads `ev.comment` with no `if (ev.type === …)` check or cast first. The `'*'` handler still receives the whole union. A handler written for the whole union still compiles. `PatcherHandlers` now requires `TEvent extends { type: string }`, as `createRealtimePatcher` already did.
- **One `onConnectionChange` subscription per transport.** `onReconnect` builds on `createConnectionState`, so a controller that used both opened two listeners on the transport, and every controller opened its own. Every `createConnectionState` and `onReconnect` on one `RealtimeService` now shares one listener. The first one opens it, and the last one to dispose or suspend closes it. One that starts while the listener is open begins at the transport's latest report, not at `'connected'`.
- **Fix: a class-based transport works with `createConnectionState`.** The method was read off the service and called unbound, so a transport whose `onConnectionChange` used `this` threw on its first report. It is now called on the service.
