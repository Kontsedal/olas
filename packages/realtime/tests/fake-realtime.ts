// In-memory transports for the realtime tests: channels you can emit on, and
// a connection you can report on. Not a test file itself.
import { type Mock, vi } from 'vitest'
import type {
  ConnectionState,
  RealtimeHandler,
  RealtimeService,
  RealtimeSubscription,
} from '../src'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    realtime: RealtimeService
  }
}

type Listener = { handler: RealtimeHandler<unknown> }

export type FakeRealtime = RealtimeService & {
  emit: (channel: string, event: unknown) => void
  subscriberCount: (channel: string) => number
  /** Every `subscribe` call, by channel name, in order. */
  subscribed: string[]
}

export const fakeRealtime = (): FakeRealtime => {
  const channels = new Map<string, Set<Listener>>()
  const subscribed: string[] = []
  return {
    subscribed,
    subscribe<TEvent = unknown>(
      channel: string,
      handler: RealtimeHandler<TEvent>,
    ): RealtimeSubscription {
      subscribed.push(channel)
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
      for (const l of channels.get(channel) ?? []) l.handler(event)
    },
    subscriberCount(channel) {
      return channels.get(channel)?.size ?? 0
    },
  }
}

export type ReportingRealtime = {
  realtime: RealtimeService
  /** Called once per `onConnectionChange` subscription the transport opened. */
  onChange: Mock
  /** Called once per unsubscribe. */
  offChange: Mock
  listenerCount: () => number
  report: (s: ConnectionState) => void
}

/**
 * A transport that reports connection changes. `initial`, when given, is
 * reported synchronously inside every `onConnectionChange` call, as many
 * real transports do.
 */
export const reportingRealtime = (initial?: ConnectionState): ReportingRealtime => {
  const handlers = new Set<(s: ConnectionState) => void>()
  const onChange = vi.fn()
  const offChange = vi.fn()
  const realtime: RealtimeService = {
    ...fakeRealtime(),
    onConnectionChange(handler) {
      onChange()
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
    onChange,
    offChange,
    listenerCount: () => handlers.size,
    report: (s: ConnectionState) => {
      for (const h of handlers) h(s)
    },
  }
}
