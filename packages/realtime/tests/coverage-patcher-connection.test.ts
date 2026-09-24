import { createRoot, defineController, queryEngine, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import {
  type ConnectionState,
  createConnectionState,
  createRealtimePatcher,
  onReconnect,
  type RealtimeHandler,
  type RealtimeService,
  type RealtimeSubscription,
} from '../src'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type Listener = { handler: RealtimeHandler<unknown> }

const fakeRealtime = () => {
  const channels = new Map<string, Set<Listener>>()
  const service: RealtimeService & {
    emit: (channel: string, event: unknown) => void
    subscriberCount: (channel: string) => number
  } = {
    subscribe<TEvent = unknown>(
      channel: string,
      handler: RealtimeHandler<TEvent>,
    ): RealtimeSubscription {
      let set = channels.get(channel)
      if (!set) {
        set = new Set()
        channels.set(channel, set)
      }
      const entry: Listener = { handler: handler as RealtimeHandler<unknown> }
      set.add(entry)
      return {
        unsubscribe() {
          set?.delete(entry)
        },
      }
    },
    emit(channel, event) {
      const set = channels.get(channel)
      if (!set) return
      for (const l of set) l.handler(event)
    },
    subscriberCount(channel) {
      return channels.get(channel)?.size ?? 0
    },
  }
  return service
}

/** A transport that reports connection changes; `initial` is emitted synchronously on subscribe. */
const reportingRealtime = (initial?: ConnectionState) => {
  const handlers = new Set<(s: ConnectionState) => void>()
  const offChange = vi.fn()
  const realtime: RealtimeService = {
    ...fakeRealtime(),
    onConnectionChange(handler) {
      handlers.add(handler)
      if (initial !== undefined) handler(initial)
      return () => {
        offChange()
        handlers.delete(handler)
      }
    },
  }
  return {
    realtime,
    offChange,
    listenerCount: () => handlers.size,
    report: (s: ConnectionState) => {
      for (const h of handlers) h(s)
    },
  }
}

type FeedEvent =
  | { type: 'like-added'; postId: string }
  | { type: 'comment-added'; postId: string; text: string }

describe("createRealtimePatcher — '*' wildcard", () => {
  test('a wildcard-only patcher receives every event, including unregistered types', () => {
    const realtime = fakeRealtime()
    const seen: unknown[] = []
    const def = defineController((ctx) => {
      createRealtimePatcher<FeedEvent>(ctx, 'feed', { '*': (e) => seen.push(e) })
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })

    const like = { type: 'like-added', postId: 'p1' }
    const unknownType = { type: 'never-registered' }
    realtime.emit('feed', like)
    realtime.emit('feed', unknownType)
    expect(seen).toEqual([like, unknownType])

    root.dispose()
    realtime.emit('feed', like)
    expect(seen).toHaveLength(2)
  })

  test('the specific handler runs first, then the wildcard sees the same event', () => {
    const realtime = fakeRealtime()
    const calls: Array<[string, unknown]> = []
    const def = defineController((ctx) => {
      createRealtimePatcher<FeedEvent>(ctx, 'feed', {
        'like-added': (e) => calls.push(['like-added', e]),
        '*': (e) => calls.push(['*', e]),
      })
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })

    const like: FeedEvent = { type: 'like-added', postId: 'p1' }
    const comment: FeedEvent = { type: 'comment-added', postId: 'p1', text: 'hi' }
    realtime.emit('feed', like)
    realtime.emit('feed', comment)
    expect(calls).toEqual([
      ['like-added', like],
      ['*', like],
      ['*', comment],
    ])
    expect(calls[1]?.[1]).toBe(like)
    root.dispose()
  })

  test('the wildcard handler is untracked too — a signal read inside it does not resubscribe', () => {
    const realtime = fakeRealtime()
    const subscribeSpy = vi.spyOn(realtime, 'subscribe')
    const tick = signal(0)
    const reads: number[] = []
    const def = defineController((ctx) => {
      createRealtimePatcher<FeedEvent>(ctx, 'feed', { '*': () => reads.push(tick.value) })
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })

    realtime.emit('feed', { type: 'like-added', postId: 'p1' })
    tick.set(1)
    tick.set(2)
    expect(reads).toEqual([0])
    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    expect(realtime.subscriberCount('feed')).toBe(1)
    root.dispose()
  })
})

describe('createConnectionState', () => {
  test('a synchronous state emitted on subscribe becomes the initial value', () => {
    const t = reportingRealtime('offline')
    const def = defineController((ctx) => ({ conn: createConnectionState(ctx) }))
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    expect(root.api.conn.value).toBe('offline')

    t.report('reconnecting')
    expect(root.api.conn.value).toBe('reconnecting')
    root.dispose()
  })

  test('dispose unsubscribes from connection changes', () => {
    const t = reportingRealtime()
    const def = defineController((ctx) => ({ conn: createConnectionState(ctx) }))
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    expect(t.listenerCount()).toBe(1)

    root.dispose()
    expect(t.offChange).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })
})

describe('onReconnect', () => {
  test('fires only on a transition back to connected, never on the initial value', () => {
    const t = reportingRealtime()
    const fn = vi.fn()
    const def = defineController((ctx) => {
      onReconnect(ctx, fn)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    // Initial optimistic 'connected' is not a transition.
    expect(fn).not.toHaveBeenCalled()

    t.report('connected')
    expect(fn).not.toHaveBeenCalled()

    t.report('offline')
    expect(fn).not.toHaveBeenCalled()
    t.report('connected')
    expect(fn).toHaveBeenCalledTimes(1)

    // A second cycle, through 'reconnecting', fires again.
    t.report('reconnecting')
    t.report('connected')
    expect(fn).toHaveBeenCalledTimes(2)

    root.dispose()
  })

  test('a transport that starts offline fires on its first connected report', () => {
    const t = reportingRealtime('offline')
    const fn = vi.fn()
    const def = defineController((ctx) => {
      onReconnect(ctx, fn)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    expect(fn).not.toHaveBeenCalled()

    t.report('connected')
    expect(fn).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('never fires when the transport cannot report connection state', () => {
    const realtime = fakeRealtime()
    const fn = vi.fn()
    const def = defineController((ctx) => {
      onReconnect(ctx, fn)
      return { conn: createConnectionState(ctx) }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime } })
    expect(root.api.conn.value).toBe('unknown')
    expect(fn).not.toHaveBeenCalled()
    root.dispose()
  })

  test('stops firing after the controller is disposed', () => {
    const t = reportingRealtime()
    const fn = vi.fn()
    const def = defineController((ctx) => {
      onReconnect(ctx, fn)
      return {}
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    t.report('offline')
    root.dispose()
    expect(t.listenerCount()).toBe(0)

    t.report('connected')
    expect(fn).not.toHaveBeenCalled()
  })
})
