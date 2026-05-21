/**
 * BroadcastChannel-backed `RealtimeService` for the demo.
 *
 * The same channel doubles as both the "remote user is editing" stand-in
 * for `@kontsedal/olas-realtime` AND the cross-tab cache sync transport
 * (the latter is wired separately via `crossTabPlugin`). Self-emitted
 * messages are filtered with a per-tab `tabId` so a tab never reacts to
 * its own writes via the patcher.
 */

import type { RealtimeEvent } from './types'

export type RealtimeSubscription = { unsubscribe(): void }
export type RealtimeHandler<T> = (event: T) => void

export type RealtimeService = {
  subscribe<T = unknown>(channel: string, handler: RealtimeHandler<T>): RealtimeSubscription
}

export type Broadcaster = {
  realtime: RealtimeService
  /** Publish an event (after the local mutation succeeds). */
  publish(event: RealtimeEvent): void
  /** This tab's stable identity. Used to filter own-source events. */
  readonly tabId: string
  /** Tear down the underlying channel. Idempotent. */
  dispose(): void
}

export const REALTIME_CHANNEL = 'olas-kanban-realtime'

function makeTabId(): string {
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Construct a Broadcaster. When `BroadcastChannel` is unavailable (jsdom
 * test env, ancient browsers), the service still works in-process — the
 * caller still gets a valid `realtime` handle and `publish` is a no-op.
 *
 * For unit tests, pass an injected `channelFactory` so an in-memory hub
 * mediates between two service instances. See `createTestBus` in the
 * realtime feature's test.
 */
export function createBroadcaster(opts?: {
  channelFactory?: (name: string) => ChannelLike
  tabId?: string
}): Broadcaster {
  const tabId = opts?.tabId ?? makeTabId()
  const factory = opts?.channelFactory ?? defaultFactory
  // One physical channel; many topic-keyed listener buckets layered over it.
  // Cheaper than a BroadcastChannel per topic and matches the typical "single
  // websocket, many channels" deployment.
  let channel: ChannelLike | null
  try {
    channel = factory(REALTIME_CHANNEL)
  } catch {
    channel = null
  }
  const listeners = new Map<string, Set<RealtimeHandler<unknown>>>()

  const onMessage = (ev: { data: unknown }) => {
    const data = ev.data as { channel?: unknown; payload?: unknown } | null
    if (!data || typeof data !== 'object') return
    const ch = (data as { channel?: unknown }).channel
    if (typeof ch !== 'string') return
    const bucket = listeners.get(ch)
    if (!bucket) return
    for (const handler of bucket) handler((data as { payload: unknown }).payload)
  }

  channel?.addEventListener('message', onMessage)

  const realtime: RealtimeService = {
    subscribe<T>(name: string, handler: RealtimeHandler<T>) {
      const bucket = listeners.get(name) ?? new Set<RealtimeHandler<unknown>>()
      listeners.set(name, bucket)
      bucket.add(handler as RealtimeHandler<unknown>)
      return {
        unsubscribe() {
          bucket.delete(handler as RealtimeHandler<unknown>)
          if (bucket.size === 0) listeners.delete(name)
        },
      }
    },
  }

  return {
    realtime,
    tabId,
    publish(event) {
      // Echo to local listeners on the next microtask so callers don't
      // observe a "fired before await" effect ordering surprise. Skipping
      // the filter for the local hop is the demo's choice — most realtime
      // services either don't echo to the publisher OR have a serverside
      // fanout that does. We match the latter shape, and let the patcher
      // filter `event.by === tabId` when it cares.
      queueMicrotask(() => {
        const bucket = listeners.get(REALTIME_CHANNEL)
        if (!bucket) return
        for (const handler of bucket) handler(event)
      })
      try {
        channel?.postMessage({ channel: REALTIME_CHANNEL, payload: event })
      } catch {
        // Structured-clone failures are silent here; the local listeners
        // still ran. Realistic shape — flaky network drops a packet.
      }
    },
    dispose() {
      channel?.removeEventListener('message', onMessage)
      channel?.close()
      channel = null
      listeners.clear()
    },
  }
}

export type ChannelLike = {
  postMessage(data: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close(): void
}

function defaultFactory(name: string): ChannelLike {
  if (typeof BroadcastChannel === 'undefined') {
    return {
      postMessage() {},
      addEventListener() {},
      removeEventListener() {},
      close() {},
    }
  }
  const ch = new BroadcastChannel(name)
  return {
    postMessage(d) {
      ch.postMessage(d)
    },
    addEventListener(t, l) {
      ch.addEventListener(t, l as unknown as EventListener)
    },
    removeEventListener(t, l) {
      ch.removeEventListener(t, l as unknown as EventListener)
    },
    close() {
      ch.close()
    },
  }
}
