import type { Ctx, ReadSignal } from '@kontsedal/olas-core'
import { signal, untracked } from '@kontsedal/olas-core'

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
}

/** Slice of `ctx.deps` consumed by this package. */
export type RealtimeDeps = { realtime: RealtimeService }

/**
 * Map of `event.type` literal → handler. Only keys present in the
 * discriminated union appear; other types are filtered out by the
 * `TEvent extends { type: infer K }` conditional.
 */
export type PatcherHandlers<TEvent> = Partial<
  Record<TEvent extends { type: infer K } ? K & string : never, (event: TEvent) => void>
>

/**
 * Subscribe to `channel` for the lifetime of the surrounding controller and
 * dispatch each event to the matching handler by `event.type`. Wrapper around
 * the recurring SPEC §16.5 "realtime → cache patches" pattern.
 *
 * Handlers run inside `untracked(...)` so accidental signal reads (e.g.
 * `query.setData((prev) => prev.value)`) don't add deps to the enclosing
 * effect, which would otherwise re-subscribe whenever those signals change.
 */
export function useRealtimePatcher<TEvent extends { type: string }>(
  ctx: Ctx<RealtimeDeps>,
  channel: string,
  handlers: PatcherHandlers<TEvent>,
): void {
  ctx.effect(() => {
    const sub = ctx.deps.realtime.subscribe<TEvent>(channel, (event) => {
      const handler = handlers[event.type as keyof PatcherHandlers<TEvent>] as
        | ((e: TEvent) => void)
        | undefined
      if (!handler) return
      untracked(() => handler(event))
    })
    return () => sub.unsubscribe()
  })
}

/**
 * Live-stream options. `capacity` is the maximum buffer length (oldest events
 * are dropped); `flushMs` coalesces bursty writes into a single signal update.
 * `flushMs <= 0` flushes synchronously per event.
 */
export type LiveStreamOptions = {
  /** Default: 1000. */
  capacity?: number
  /** Default: 16. Set to 0 (or negative) for synchronous flush. */
  flushMs?: number
}

/**
 * Live-streaming buffer over a single realtime channel. Pause/resume
 * controls the subscription (not the buffer — buffered events are preserved
 * across a pause). `clear()` empties the buffer without touching the
 * subscription. SPEC §16.5 tail-buffer pattern.
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
 * Naming: the `use*` prefix matches the spec convention for ctx-taking
 * composables (`usePersisted`, `useRealtimePatcher`). The `define*` prefix is
 * reserved for module-scope factories (`defineQuery`, `defineController`).
 *
 * Buffer semantics (SPEC §16.5):
 * - `capacity` caps memory; oldest entries drop when exceeded.
 * - `flushMs` coalesces N events into one signal write — prevents thrashing
 *   under 1000-events/sec bursts. `flushMs <= 0` flushes synchronously.
 * - `pause()` stops the subscription; the buffer is preserved across pause.
 * - `clear()` resets the buffer (and any unflushed pending events) without
 *   touching the subscription.
 */
export function useLiveStream<TEvent>(
  ctx: Ctx<RealtimeDeps>,
  channel: string,
  options?: LiveStreamOptions,
): LiveStream<TEvent> {
  const capacity = options?.capacity ?? DEFAULT_CAPACITY
  if (capacity < 1) {
    throw new RangeError(`[olas/realtime] useLiveStream: capacity must be >= 1, got ${capacity}`)
  }
  const flushMs = options?.flushMs ?? DEFAULT_FLUSH_MS
  const syncFlush = flushMs <= 0

  const events$ = signal<readonly TEvent[]>([])
  const isPaused$ = signal(false)

  // `pending` accumulates events between coalesced flushes. We intentionally
  // preserve `pending` across pause(): events queued in the same tick as the
  // pause haven't been flushed yet, and dropping them would surprise callers
  // who expect "every event the subscription saw is buffered eventually".
  let pending: TEvent[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (pending.length === 0) {
      flushTimer = null
      return
    }
    const next = events$.peek().concat(pending).slice(-capacity)
    pending = []
    flushTimer = null
    events$.set(next)
  }

  ctx.effect(() => {
    if (isPaused$.value) return
    const sub = ctx.deps.realtime.subscribe<TEvent>(channel, (event) => {
      pending.push(event)
      if (syncFlush) {
        flush()
        return
      }
      if (flushTimer == null) {
        flushTimer = setTimeout(flush, flushMs)
      }
    })
    return () => {
      sub.unsubscribe()
      if (flushTimer != null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
    }
  })

  return {
    events: events$,
    isPaused: isPaused$,
    pause: () => isPaused$.set(true),
    resume: () => isPaused$.set(false),
    clear: () => {
      pending = []
      if (flushTimer != null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      events$.set([])
    },
  }
}
