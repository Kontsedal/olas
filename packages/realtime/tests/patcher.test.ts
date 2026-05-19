import { createRoot, defineController, signal } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import {
  type RealtimeHandler,
  type RealtimeService,
  type RealtimeSubscription,
  useRealtimePatcher,
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

type FeedEvent =
  | { type: 'like-added'; postId: string }
  | { type: 'comment-added'; postId: string; text: string }

describe('useRealtimePatcher', () => {
  test('subscribes to the channel on mount', () => {
    const realtime = fakeRealtime()
    const def = defineController((ctx) => {
      useRealtimePatcher<FeedEvent>(ctx, 'feed', {})
      return {}
    })
    const root = createRoot(def, { deps: { realtime } })
    expect(realtime.subscriberCount('feed')).toBe(1)
    root.dispose()
  })

  test('dispatches events to the matching type handler', () => {
    const realtime = fakeRealtime()
    const onLike = vi.fn<(e: FeedEvent) => void>()
    const onComment = vi.fn<(e: FeedEvent) => void>()
    const def = defineController((ctx) => {
      useRealtimePatcher<FeedEvent>(ctx, 'feed', {
        'like-added': onLike,
        'comment-added': onComment,
      })
      return {}
    })
    const root = createRoot(def, { deps: { realtime } })

    const ev: FeedEvent = { type: 'like-added', postId: 'p1' }
    realtime.emit('feed', ev)
    expect(onLike).toHaveBeenCalledTimes(1)
    expect(onLike).toHaveBeenCalledWith(ev)
    expect(onComment).not.toHaveBeenCalled()

    root.dispose()
  })

  test('ignores unknown event types without throwing', () => {
    const realtime = fakeRealtime()
    const onLike = vi.fn<(e: FeedEvent) => void>()
    const def = defineController((ctx) => {
      useRealtimePatcher<FeedEvent>(ctx, 'feed', {
        'like-added': onLike,
      })
      return {}
    })
    const root = createRoot(def, { deps: { realtime } })

    expect(() => realtime.emit('feed', { type: 'never-registered' })).not.toThrow()
    expect(onLike).not.toHaveBeenCalled()

    root.dispose()
  })

  test('unsubscribes on dispose', () => {
    const realtime = fakeRealtime()
    const onLike = vi.fn<(e: FeedEvent) => void>()
    const def = defineController((ctx) => {
      useRealtimePatcher<FeedEvent>(ctx, 'feed', { 'like-added': onLike })
      return {}
    })
    const root = createRoot(def, { deps: { realtime } })
    expect(realtime.subscriberCount('feed')).toBe(1)

    root.dispose()
    expect(realtime.subscriberCount('feed')).toBe(0)

    realtime.emit('feed', { type: 'like-added', postId: 'p1' })
    expect(onLike).not.toHaveBeenCalled()
  })

  test('handlers are wrapped in untracked — reading a signal inside does not retrigger the effect', () => {
    // If handlers were NOT wrapped in untracked, reading `tick.value` inside
    // the handler would add `tick` as a dep of the ctx.effect that owns the
    // subscription. Subsequent `tick.set(...)` would then dispose the
    // subscription and re-subscribe — increasing total subscribe-call count.
    const realtime = fakeRealtime()
    const subscribeSpy = vi.spyOn(realtime, 'subscribe')
    const tick = signal(0)

    const def = defineController((ctx) => {
      useRealtimePatcher<FeedEvent>(ctx, 'feed', {
        'like-added': () => {
          // Tracked read attempt — should be neutralized by untracked wrap.
          void tick.value
        },
      })
      return {}
    })
    const root = createRoot(def, { deps: { realtime } })

    expect(subscribeSpy).toHaveBeenCalledTimes(1)
    realtime.emit('feed', { type: 'like-added', postId: 'p1' })

    // Mutate the signal; if the effect picked it up as a dep, it would
    // re-run and call subscribe a second time.
    tick.set(1)
    tick.set(2)
    expect(subscribeSpy).toHaveBeenCalledTimes(1)

    root.dispose()
  })
})
