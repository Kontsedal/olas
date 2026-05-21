/**
 * Test harness helpers shared across tests.
 *
 * `createKanbanRoot` builds a root with the same plugin set as production, but
 * lets each test inject its own broadcaster (for cross-tab + realtime
 * isolation) and storage adapter (for usePersisted).
 */

import { createRoot } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import type { StorageAdapter } from '@kontsedal/olas-persist'
import {
  type Api,
  type Broadcaster,
  type ChannelLike,
  createBroadcaster,
  createFakeApi,
} from '../src/api'
import type { NotifyRef } from '../src/api/schema'
import { appController } from '../src/app.controller'
import { createEntitiesPlugin } from '../src/entities'

/** In-memory `Map`-backed `StorageAdapter` for tests. */
export function memoryStorage(): StorageAdapter {
  const store = new Map<string, string>()
  let listener: ((key: string, value: string | null) => void) | null = null
  return {
    get: (k) => store.get(k) ?? null,
    set: (k, v) => {
      store.set(k, v)
      listener?.(k, v)
    },
    delete: (k) => {
      store.delete(k)
      listener?.(k, null)
    },
    onChange(handler) {
      listener = handler
      return () => {
        if (listener === handler) listener = null
      }
    },
  }
}

/**
 * Shared in-memory channel hub. Two `createTestBroadcaster(bus)` instances
 * see each other's messages — used to test cross-tab cache sync.
 */
export type TestBus = {
  factory: (name: string) => ChannelLike
  channels: Map<string, Set<(d: unknown) => void>>
}

export function createTestBus(): TestBus {
  const channels = new Map<string, Set<(d: unknown) => void>>()
  const factory = (name: string): ChannelLike => {
    const bucket = channels.get(name) ?? new Set()
    channels.set(name, bucket)
    let listener: ((event: { data: unknown }) => void) | null = null
    const wrappedHandler = (d: unknown) => listener?.({ data: d })
    return {
      postMessage: (data) => {
        // Echo to every OTHER listener (BroadcastChannel doesn't echo own).
        for (const h of bucket) {
          if (h === wrappedHandler) continue
          h(data)
        }
      },
      addEventListener: (_type, l) => {
        listener = l
        bucket.add(wrappedHandler)
      },
      removeEventListener: () => {
        bucket.delete(wrappedHandler)
        listener = null
      },
      close: () => {
        bucket.delete(wrappedHandler)
        listener = null
      },
    }
  }
  return { factory, channels }
}

export type RootHandle = ReturnType<typeof createKanbanRoot>

export function createKanbanRoot(opts?: {
  api?: Api
  broadcaster?: Broadcaster
  storage?: StorageAdapter
  channelFactory?: (name: string) => ChannelLike
  tabId?: string
}) {
  const api = opts?.api ?? createFakeApi()
  const broadcaster =
    opts?.broadcaster ??
    createBroadcaster({ channelFactory: opts?.channelFactory, tabId: opts?.tabId })
  const entities = createEntitiesPlugin()
  const notifyRef: NotifyRef = { current: () => {} }
  const root = createRoot(appController, {
    deps: {
      api,
      broadcaster,
      realtime: broadcaster.realtime,
      tabId: broadcaster.tabId,
      entities,
      notifyRef,
      storage: opts?.storage,
    },
    plugins: [
      entities,
      crossTabPlugin({
        channelName: 'olas-kanban-cache',
        channelFactory: opts?.channelFactory,
      }),
    ],
  })
  return {
    root,
    broadcaster,
    api,
    dispose: () => {
      root.dispose()
      broadcaster.dispose()
    },
  }
}

/** Drain microtasks. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0))
