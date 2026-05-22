/**
 * Shared fixtures for the integration test suite. Lives here so every
 * scenario file imports the SAME bus / adapter / clock helpers — divergence
 * between tests has historically masked real bugs (e.g. one bus that
 * synchronously echoes vs. one that doesn't).
 */

import type { ChannelLike } from '@kontsedal/olas-cross-tab'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import type {
  ConnectionState,
  RealtimeHandler,
  RealtimeService,
  RealtimeSubscription,
} from '@kontsedal/olas-realtime'

/** Drain the microtask queue once. */
export const flush = (): Promise<void> => new Promise<void>((r) => queueMicrotask(r))

/** Drain microtasks N times — enough for nested async fetches to settle. */
export const settle = async (cycles = 10): Promise<void> => {
  for (let i = 0; i < cycles; i++) await flush()
}

/** Externally-resolvable promise. */
export const deferred = <T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (err: unknown) => void
} => {
  let resolve: (v: T) => void = () => {}
  let reject: (err: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// ---- in-memory StorageAdapter --------------------------------------------

export type MemoryAdapter = StorageAdapter & {
  /** Direct access for assertions. */
  store: Map<string, string>
  /** Simulate an external write — fires the onChange handler. */
  emitChange: (key: string, value: string | null) => void
}

/**
 * Synchronous in-memory storage adapter with `keys()` (needed by the
 * mutation-queue replay path) and `onChange` (needed by `usePersisted`
 * cross-tab sync).
 */
export const memoryAdapter = (initial: Record<string, string> = {}): MemoryAdapter => {
  const store = new Map(Object.entries(initial))
  const listeners = new Set<(key: string, value: string | null) => void>()
  return {
    store,
    emitChange(key, value) {
      for (const l of listeners) l(key, value)
    },
    get: (key) => store.get(key) ?? null,
    set: (key, value) => {
      store.set(key, value)
    },
    delete: (key) => {
      store.delete(key)
    },
    onChange: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    keys: () => [...store.keys()],
  }
}

// ---- in-memory BroadcastChannel bus --------------------------------------

type ChannelListener = (event: { data: unknown }) => void
type BusEntry = { listeners: Set<ChannelListener>; postCount: number }

/**
 * Shared in-memory bus shared by N "tabs" — each tab calls the factory
 * with the same channelName and gets a `ChannelLike` whose `postMessage`
 * is delivered to all OTHER tabs (no echo back to sender). Mirrors real
 * `BroadcastChannel` semantics enough to exercise the cross-tab plugin.
 */
export const createBusFactory = (): {
  factory: (name: string) => ChannelLike
  postCount: (name: string) => number
  listenerCount: (name: string) => number
} => {
  const buses = new Map<string, BusEntry>()
  const getBus = (name: string): BusEntry => {
    let bus = buses.get(name)
    if (!bus) {
      bus = { listeners: new Set(), postCount: 0 }
      buses.set(name, bus)
    }
    return bus
  }

  const factory = (name: string): ChannelLike => {
    const bus = getBus(name)
    const local = new Set<ChannelListener>()
    return {
      postMessage(data) {
        bus.postCount += 1
        for (const l of bus.listeners) {
          if (local.has(l)) continue
          queueMicrotask(() => l({ data }))
        }
      },
      addEventListener(_type, listener) {
        bus.listeners.add(listener)
        local.add(listener)
      },
      removeEventListener(_type, listener) {
        bus.listeners.delete(listener)
        local.delete(listener)
      },
      close() {
        for (const l of local) bus.listeners.delete(l)
        local.clear()
      },
    }
  }

  return {
    factory,
    postCount: (name) => getBus(name).postCount,
    listenerCount: (name) => getBus(name).listeners.size,
  }
}

// ---- in-memory RealtimeService -------------------------------------------

export type FakeRealtime = RealtimeService & {
  emit: (channel: string, event: unknown) => void
  setState: (state: ConnectionState) => void
  subscriberCount: (channel: string) => number
}

/**
 * Hand-rolled realtime transport. `emit(channel, event)` synchronously
 * dispatches to every subscriber; `setState(s)` fires all registered
 * connection-state listeners (used to drive `useRealtimeConnection`).
 */
export const fakeRealtime = (): FakeRealtime => {
  const channels = new Map<string, Set<{ handler: RealtimeHandler<unknown> }>>()
  const stateListeners = new Set<(s: ConnectionState) => void>()
  return {
    subscribe<TEvent = unknown>(
      channel: string,
      handler: RealtimeHandler<TEvent>,
    ): RealtimeSubscription {
      let set = channels.get(channel)
      if (!set) {
        set = new Set()
        channels.set(channel, set)
      }
      const entry = { handler: handler as RealtimeHandler<unknown> }
      set.add(entry)
      return {
        unsubscribe() {
          set?.delete(entry)
        },
      }
    },
    onConnectionChange(handler) {
      stateListeners.add(handler)
      return () => stateListeners.delete(handler)
    },
    emit(channel, event) {
      const set = channels.get(channel)
      if (!set) return
      for (const l of set) l.handler(event)
    },
    setState(state) {
      for (const l of stateListeners) l(state)
    },
    subscriberCount(channel) {
      return channels.get(channel)?.size ?? 0
    },
  }
}
