import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { batch, signal, untracked } from '@kontsedal/olas-core'

/**
 * A handle returned by `RealtimeService.subscribe(...)`. Matches the shape
 * used by most WebSocket / SSE / Pusher / Ably / Supabase clients in the
 * wild. SPEC §16.5.
 */
export type RealtimeSubscription = { unsubscribe(): void }

/** Per-event callback handed to `RealtimeService.subscribe`. */
export type RealtimeHandler<TEvent> = (event: TEvent) => void

/**
 * Consumer-implemented realtime transport. The package ships no default —
 * apps wire their own (WebSocket, Pusher, Supabase Realtime, etc.) and pass
 * the implementation through `ctx.deps.realtime` after augmenting
 * `AmbientDeps`:
 *
 * ```ts
 * declare module '@kontsedal/olas-core' {
 *   interface AmbientDeps {
 *     realtime: RealtimeService
 *   }
 * }
 * ```
 */
export type RealtimeService = {
  subscribe<TEvent = unknown>(
    channel: string,
    handler: RealtimeHandler<TEvent>,
  ): RealtimeSubscription
  /**
   * Optional. Subscribe to connection-state changes. When implemented,
   * `createConnectionState(ctx)` returns a live signal of the state;
   * otherwise it returns a constant `'unknown'` signal.
   *
   * Four states:
   * - `'connected'`: subscriptions actively receive events.
   * - `'reconnecting'`: transport is mid-recovery; subscriptions may
   *   miss events during the gap.
   * - `'offline'`: no connection; subscriptions are paused at the
   *   transport.
   * - `'unknown'`: only reported by `createConnectionState` when the
   *   transport doesn't implement `onConnectionChange` — the hook can't
   *   observe state, so it says so rather than claiming `'connected'`.
   *
   * Returns an unsubscribe function. Many transports emit a synchronous
   * "current state" callback on subscribe — that's fine; the hook reads
   * it as the initial value.
   */
  onConnectionChange?(handler: (state: ConnectionState) => void): () => void
}

/**
 * A realtime transport's connection state, as `createConnectionState` reports
 * it. `'unknown'` means the transport has no `onConnectionChange`, so the
 * state cannot be observed. `RealtimeService.onConnectionChange` describes the
 * other three.
 */
export type ConnectionState = 'connected' | 'reconnecting' | 'offline' | 'unknown'

/** Slice of `ctx.deps` consumed by this package. */
export type RealtimeDeps = { realtime: RealtimeService }

/**
 * Map of `event.type` literal → handler. Each key is one `type` of the
 * discriminated union, and its handler receives that variant only:
 * `Extract<TEvent, { type: K }>`, so `'comment-added': (ev) => ev.comment`
 * needs no narrowing.
 *
 * The `'*'` wildcard key receives every event the dispatcher saw, typed as
 * the whole union, including those a specific handler already consumed. Use
 * it for logging, instrumentation, or "I don't know all the types yet"
 * diagnostics.
 */
export type PatcherHandlers<TEvent extends { type: string }> = {
  [K in TEvent['type']]?: (event: Extract<TEvent, { type: K }>) => void
} & {
  '*'?: (event: TEvent) => void
}

/** The channel's name now: a string as it is, a signal's current value. */
const channelName = (channel: string | ReadSignal<string>): string =>
  typeof channel === 'string' ? channel : channel.value

/**
 * Subscribe to `channel` for the lifetime of the surrounding controller and
 * dispatch each event to the matching handler by `event.type`. Wrapper around
 * the recurring SPEC §16.5 "realtime → cache patches" pattern.
 *
 * `channel` is a name or a signal of one. With a signal, a new name
 * unsubscribes from the old channel and subscribes to the new one, so a
 * per-route room is `computed(() => 'room:' + params.value.roomId)`.
 *
 * Handlers run inside `untracked(...)` so accidental signal reads (e.g.
 * `query.setData((prev) => prev.value)`) don't add deps to the enclosing
 * effect, which would otherwise re-subscribe whenever those signals change.
 *
 * A `'*'` wildcard handler is invoked for every event, regardless of
 * whether a specific handler matched. Specific handlers run first; the
 * wildcard sees the same event afterwards (in the same `untracked` scope).
 */
export function createRealtimePatcher<TEvent extends { type: string }>(
  ctx: Ctx<RealtimeDeps>,
  channel: string | ReadSignal<string>,
  handlers: PatcherHandlers<TEvent>,
): void {
  ctx.effect(() => {
    const sub = ctx.deps.realtime.subscribe<TEvent>(channelName(channel), (event) => {
      // The map types each handler by its own variant; `event` is the union.
      const handler = handlers[event.type as TEvent['type']] as ((e: TEvent) => void) | undefined
      const wildcard = handlers['*']
      if (handler === undefined && wildcard === undefined) return
      untracked(() => {
        if (handler !== undefined) handler(event)
        if (wildcard !== undefined) wildcard(event)
      })
    })
    return () => sub.unsubscribe()
  })
}

/**
 * Live-stream options. `capacity` is the maximum buffer length (oldest events
 * are dropped); `flushMs` coalesces bursty writes into a single signal update.
 * `flushMs <= 0` flushes synchronously per event.
 */
export type LiveStreamOptions<TEvent = unknown> = {
  /**
   * Default: 1000.
   */
  capacity?: number
  /**
   * Default: 16. Set to 0 (or negative) for synchronous flush.
   */
  flushMs?: number
  /**
   * Coalesce flushes against `requestAnimationFrame` instead of
   * `setTimeout(flushMs)`. Best for tail-view UIs (live chat, log viewer)
   * that re-render on the frame. When set, `flushMs` is ignored.
   *
   * Defaults to `false`. In environments without `requestAnimationFrame`
   * (Node, SSR) the option silently falls back to `setTimeout(0)`.
   */
  rafFlush?: boolean
  /**
   * Fires when events are dropped to honor the `capacity` cap. Receives
   * the dropped slice (oldest first) so consumers can persist, count,
   * or surface "X events lost in this window." Without this, oldest-
   * drop is silent.
   */
  onDrop?: (dropped: readonly TEvent[]) => void
}

/**
 * Live-streaming buffer over a single realtime channel. Pause/resume
 * controls the subscription (not the buffer — already-buffered events are
 * preserved across a pause). **Events that arrive DURING a pause are lost:**
 * `pause()` tears down the underlying subscription, so nothing is received
 * (let alone buffered) until `resume()`. To recover a gap, pair with
 * `onReconnect(...)` + a query `invalidate` (refetch authoritative state)
 * rather than relying on the buffer. `clear()` empties the buffer without
 * touching the subscription. A channel signal's change empties it too, since
 * the buffered events came from the old channel. SPEC §16.5 tail-buffer
 * pattern.
 */
export type LiveStream<TEvent> = {
  events: ReadSignal<readonly TEvent[]>
  isPaused: ReadSignal<boolean>
  pause(): void
  resume(): void
  clear(): void
}

const DEFAULT_CAPACITY = 1000
const DEFAULT_FLUSH_MS = 16

/**
 * Subscribe to `channel`, buffer events into a `ReadSignal<readonly TEvent[]>`
 * with `capacity` oldest-drop semantics and `flushMs` coalescing. The
 * subscription lives inside `ctx.effect` so pause/resume re-runs it (we read
 * `isPaused.value` as a tracked dep).
 *
 * Naming: the `create*` prefix is the convention for ctx-taking
 * composables (`createPersisted`, `createRealtimePatcher`). The `define*` prefix is
 * reserved for module-scope factories (`defineQuery`, `defineController`).
 *
 * Buffer semantics (SPEC §16.5):
 * - `capacity` caps memory; oldest entries drop when exceeded.
 * - `flushMs` coalesces N events into one signal write — prevents thrashing
 *   under 1000-events/sec bursts. `flushMs <= 0` flushes synchronously.
 * - `pause()` tears down the subscription; already-buffered events survive,
 *   but events arriving DURING the pause are LOST (not received). Recover a
 *   gap with `onReconnect(...)` + query `invalidate`, not the buffer.
 * - `clear()` resets the buffer (and any unflushed pending events) without
 *   touching the subscription.
 * - `channel` is a name or a signal of one. A new name moves the
 *   subscription to the new channel and empties the buffer, as `clear()`
 *   does: a tail holds one channel's events, and nothing in an event says
 *   which channel it came from. A change during a pause empties it too, and
 *   `resume()` subscribes to the new name.
 */
export function createLiveStream<TEvent>(
  ctx: Ctx<RealtimeDeps>,
  channel: string | ReadSignal<string>,
  options?: LiveStreamOptions<TEvent>,
): LiveStream<TEvent> {
  const capacity = options?.capacity ?? DEFAULT_CAPACITY
  if (capacity < 1) {
    throw new RangeError(`[olas/realtime] createLiveStream: capacity must be >= 1, got ${capacity}`)
  }
  const flushMs = options?.flushMs ?? DEFAULT_FLUSH_MS
  const rafFlush = options?.rafFlush === true
  const syncFlush = !rafFlush && flushMs <= 0
  const onDrop = options?.onDrop

  const events$ = signal<readonly TEvent[]>([])
  const isPaused$ = signal(false)

  // `pending` accumulates events between coalesced flushes. We intentionally
  // preserve `pending` across pause(): events queued in the same tick as the
  // pause haven't been flushed yet, and dropping them would surprise callers
  // who expect "every event the subscription saw is buffered eventually".
  let pending: TEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let rafHandle: number | null = null

  const flush = () => {
    if (pending.length === 0) {
      flushTimer = null
      rafHandle = null
      return
    }
    const merged = events$.peek().concat(pending)
    pending = []
    flushTimer = null
    rafHandle = null
    if (merged.length > capacity) {
      const dropCount = merged.length - capacity
      if (onDrop !== undefined) {
        try {
          onDrop(merged.slice(0, dropCount))
        } catch {
          /* drop-handler errors must not break the stream */
        }
      }
      events$.set(merged.slice(dropCount))
    } else {
      events$.set(merged)
    }
  }

  const scheduleFlush = () => {
    if (syncFlush) {
      flush()
      return
    }
    if (rafFlush) {
      // One pending frame (or its setTimeout stand-in) at a time: a second
      // event before it fires joins the same flush.
      if (rafHandle !== null || flushTimer !== null) return
      if (typeof requestAnimationFrame === 'function') {
        rafHandle = requestAnimationFrame(() => {
          rafHandle = null
          flush()
        })
      } else {
        // No rAF (Node / SSR) — degrade to setTimeout(0).
        flushTimer = setTimeout(() => {
          flushTimer = null
          flush()
        }, 0)
      }
      return
    }
    if (flushTimer == null) {
      flushTimer = setTimeout(flush, flushMs)
    }
  }

  const cancelFlush = () => {
    if (flushTimer != null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (rafHandle != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(rafHandle)
      rafHandle = null
    }
  }

  const clear = () => {
    pending = []
    cancelFlush()
    events$.set([])
  }

  // The channel the buffered events came from.
  let bufferedFrom: string | undefined

  ctx.effect(() => {
    // Read the channel before the pause flag, so a change re-runs this effect
    // during a pause too.
    const name = channelName(channel)
    if (bufferedFrom !== undefined && name !== bufferedFrom) clear()
    bufferedFrom = name
    if (isPaused$.value) return
    // Events buffered during the previous run that the cleanup cleared the
    // timer for (i.e. pause() fired before the trailing flush) would sit
    // forever otherwise; reschedule the flush as we re-subscribe so they
    // eventually land in `events$`.
    if (pending.length > 0) scheduleFlush()
    const sub = ctx.deps.realtime.subscribe<TEvent>(name, (event) => {
      pending.push(event)
      scheduleFlush()
    })
    return () => {
      sub.unsubscribe()
      cancelFlush()
    }
  })

  return {
    events: events$,
    isPaused: isPaused$,
    pause: () => isPaused$.set(true),
    resume: () => isPaused$.set(false),
    clear,
  }
}

/**
 * Reactive connection-state signal — `'connected' | 'reconnecting' | 'offline' | 'unknown'`.
 *
 * Backed by `RealtimeService.onConnectionChange?(...)`. If the consumer's
 * transport doesn't implement that method, the returned signal stays at
 * `'unknown'` for the lifetime of the controller — the hook has no way to
 * observe connection state, so it reports that honestly rather than lying
 * with `'connected'` (T6.7). With a reporter, it starts optimistically at
 * `'connected'` until the first change corrects it.
 *
 * Every `createConnectionState` and `onReconnect` on one `RealtimeService`
 * shares one `onConnectionChange` listener. The first live one subscribes,
 * and the last one to dispose (or suspend) unsubscribes. One that starts
 * while the listener is live begins at the transport's latest report, since
 * the transport's own "current state" call came once, on that subscribe.
 *
 * Useful for "stale-during-disconnect" UIs and as a refetch trigger when
 * the connection comes back up:
 *
 * ```ts
 * const conn = createConnectionState(ctx)
 * const orders = bindQuery(ctx, ordersQuery)
 * ctx.effect(() => {
 *   if (conn.value === 'connected') {
 *     orders.invalidateAll()
 *   }
 * })
 * ```
 */
export function createConnectionState(ctx: Ctx<RealtimeDeps>): ReadSignal<ConnectionState> {
  const service = ctx.deps.realtime
  const report = service.onConnectionChange
  // A transport WITHOUT `onConnectionChange` can't report status — report
  // `'unknown'` instead of claiming `'connected'` (T6.7).
  if (report === undefined) return signal<ConnectionState>('unknown')
  // With a reporter, start optimistically at `'connected'` until the first
  // report corrects it.
  const state$ = signal<ConnectionState>('connected')
  const listener = (s: ConnectionState) => state$.set(s)
  ctx.effect(() => joinConnection(service, report, listener))
  return state$
}

type ConnectionListener = (state: ConnectionState) => void

/**
 * One `onConnectionChange` subscription per transport, fanned out to every
 * live `createConnectionState`. `last` is the latest report while the
 * subscription is open, for a listener that joins after it opened.
 */
type ConnectionHub = {
  listeners: Set<ConnectionListener>
  last?: ConnectionState | undefined
  off?: (() => void) | undefined
}

const hubs = new WeakMap<RealtimeService, ConnectionHub>()

/** Add `listener` to the service's shared subscription; returns its removal. */
function joinConnection(
  service: RealtimeService,
  report: (handler: ConnectionListener) => () => void,
  listener: ConnectionListener,
): () => void {
  let h = hubs.get(service)
  if (h === undefined) {
    h = { listeners: new Set() }
    hubs.set(service, h)
  }
  const hub = h
  if (hub.listeners.size === 0) {
    // Open before adding the listener: a throw here leaves the hub closed and
    // empty, so the next listener tries again. Called on the service, so a
    // class-based transport keeps its `this`.
    hub.off = report.call(service, (s) => {
      hub.last = s
      batch(() => {
        for (const l of hub.listeners) l(s)
      })
    })
  }
  hub.listeners.add(listener)
  // A transport's synchronous "current state" call reached the hub once, when
  // it opened; `last` hands it to every listener that joins after.
  if (hub.last !== undefined) listener(hub.last)
  return () => {
    hub.listeners.delete(listener)
    if (hub.listeners.size > 0) return
    const off = hub.off
    hub.off = undefined
    hub.last = undefined
    off?.()
  }
}

/**
 * Trigger `fn()` when the realtime connection transitions back to
 * `'connected'` from a non-connected state. Typical use: invalidate
 * queries that may have missed updates during the disconnect window.
 *
 * The handler fires AFTER the transition is observed; it does NOT fire on
 * the initial `'connected'` value (no transition happened yet). Wrapped
 * in `untracked` so cache writes don't accidentally hook the effect.
 */
export function onReconnect(ctx: Ctx<RealtimeDeps>, fn: () => void): void {
  const conn = createConnectionState(ctx)
  let prev: ConnectionState = conn.peek()
  ctx.effect(() => {
    const next = conn.value
    if (next === 'connected' && prev !== 'connected') {
      untracked(fn)
    }
    prev = next
  })
}
