// `createConnectionState` and `onReconnect` share one `onConnectionChange`
// subscription per transport.
import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import { describe, expect, test, vi } from 'vitest'
import {
  type ConnectionState,
  createConnectionState,
  onReconnect,
  type RealtimeService,
} from '../src'
import { fakeRealtime, reportingRealtime } from './fake-realtime'

describe('one connection subscription per transport', () => {
  test('createConnectionState and onReconnect in one controller open one subscription', () => {
    const t = reportingRealtime()
    const fn = vi.fn()
    const def = defineController((ctx) => {
      const conn = createConnectionState(ctx)
      onReconnect(ctx, fn)
      return { conn }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    expect(t.onChange).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(1)

    // Both still see every report.
    t.report('offline')
    expect(root.api.conn.value).toBe('offline')
    t.report('connected')
    expect(root.api.conn.value).toBe('connected')
    expect(fn).toHaveBeenCalledTimes(1)

    root.dispose()
    expect(t.offChange).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })

  test('the subscription stays open until the last user disposes', () => {
    const t = reportingRealtime()
    const make = () =>
      createRoot(
        defineController((ctx) => ({ conn: createConnectionState(ctx) })),
        { queries: queryEngine(), deps: { realtime: t.realtime } },
      )
    const first = make()
    const second = make()
    expect(t.onChange).toHaveBeenCalledTimes(1)

    first.dispose()
    expect(t.offChange).not.toHaveBeenCalled()
    t.report('reconnecting')
    expect(second.api.conn.value).toBe('reconnecting')

    second.dispose()
    expect(t.offChange).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })

  test('a user that joins an open subscription starts at the latest report', () => {
    // The transport reports 'offline' once, synchronously, on its one subscribe.
    const t = reportingRealtime('offline')
    const make = () =>
      createRoot(
        defineController((ctx) => ({ conn: createConnectionState(ctx) })),
        { queries: queryEngine(), deps: { realtime: t.realtime } },
      )
    const first = make()
    expect(first.api.conn.value).toBe('offline')
    const second = make()
    expect(t.onChange).toHaveBeenCalledTimes(1)
    expect(second.api.conn.value).toBe('offline')

    // onReconnect joining the same subscription sees 'offline' as its start,
    // so the next 'connected' is a reconnect.
    const fn = vi.fn()
    const third = createRoot(
      defineController((ctx) => {
        onReconnect(ctx, fn)
        return {}
      }),
      { queries: queryEngine(), deps: { realtime: t.realtime } },
    )
    t.report('connected')
    expect(fn).toHaveBeenCalledTimes(1)

    first.dispose()
    second.dispose()
    third.dispose()
  })

  test('a user that joins before any report starts optimistic', () => {
    const t = reportingRealtime()
    const make = () =>
      createRoot(
        defineController((ctx) => ({ conn: createConnectionState(ctx) })),
        { queries: queryEngine(), deps: { realtime: t.realtime } },
      )
    const first = make()
    const second = make()
    expect(second.api.conn.value).toBe('connected')
    first.dispose()
    second.dispose()
  })

  test('after the last user leaves, the next one subscribes again and starts optimistic', () => {
    const t = reportingRealtime()
    const make = () =>
      createRoot(
        defineController((ctx) => ({ conn: createConnectionState(ctx) })),
        { queries: queryEngine(), deps: { realtime: t.realtime } },
      )
    const first = make()
    t.report('offline')
    first.dispose()

    // The 'offline' report belonged to the closed subscription.
    const second = make()
    expect(t.onChange).toHaveBeenCalledTimes(2)
    expect(second.api.conn.value).toBe('connected')
    second.dispose()
  })

  test('transports are not shared with each other', () => {
    const a = reportingRealtime()
    const b = reportingRealtime()
    const make = (realtime: RealtimeService) =>
      createRoot(
        defineController((ctx) => ({ conn: createConnectionState(ctx) })),
        { queries: queryEngine(), deps: { realtime } },
      )
    const onA = make(a.realtime)
    const onB = make(b.realtime)
    a.report('offline')
    expect(onA.api.conn.value).toBe('offline')
    expect(onB.api.conn.value).toBe('connected')
    onA.dispose()
    onB.dispose()
  })

  test('a suspended user leaves the subscription, and resuming joins it again', () => {
    const t = reportingRealtime()
    const def = defineController((ctx) => ({ conn: createConnectionState(ctx) }))
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    t.report('offline')

    root.suspend()
    expect(t.listenerCount()).toBe(0)
    root.resume()
    expect(t.onChange).toHaveBeenCalledTimes(2)
    t.report('connected')
    expect(root.api.conn.value).toBe('connected')
    root.dispose()
  })

  test('resuming into a fresh subscription starts optimistic again, and that is a reconnect', () => {
    // The transport reports changes only. It came back while the controller was
    // suspended, with nothing listening, and says nothing on the next subscribe.
    const t = reportingRealtime()
    const fn = vi.fn()
    const def = defineController((ctx) => {
      const conn = createConnectionState(ctx)
      onReconnect(ctx, fn)
      return { conn }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    t.report('offline')
    expect(root.api.conn.value).toBe('offline')

    root.suspend()
    root.resume()
    expect(root.api.conn.value).toBe('connected')
    expect(fn).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('a transport that reports its state on subscribe is not reset first', () => {
    const t = reportingRealtime('offline')
    const fn = vi.fn()
    const def = defineController((ctx) => {
      const conn = createConnectionState(ctx)
      onReconnect(ctx, fn)
      return { conn }
    })
    const root = createRoot(def, { queries: queryEngine(), deps: { realtime: t.realtime } })
    expect(root.api.conn.value).toBe('offline')

    root.suspend()
    root.resume()
    expect(root.api.conn.value).toBe('offline')
    expect(fn).not.toHaveBeenCalled()
    root.dispose()
  })
})

describe('connection transports', () => {
  test('a class-based transport is called as a method and keeps its `this`', () => {
    class Transport implements RealtimeService {
      private readonly handlers = new Set<(s: ConnectionState) => void>()
      subscribe() {
        return { unsubscribe() {} }
      }
      onConnectionChange(handler: (s: ConnectionState) => void) {
        this.handlers.add(handler)
        return () => {
          this.handlers.delete(handler)
        }
      }
      report(s: ConnectionState) {
        for (const h of this.handlers) h(s)
      }
    }
    const realtime = new Transport()
    const onError = vi.fn()
    const root = createRoot(
      defineController((ctx) => ({ conn: createConnectionState(ctx) })),
      { queries: queryEngine(), deps: { realtime }, onError },
    )
    realtime.report('reconnecting')
    expect(onError).not.toHaveBeenCalled()
    expect(root.api.conn.value).toBe('reconnecting')
    root.dispose()
  })

  test('a throwing onConnectionChange reports the error and leaves the next user free to subscribe', () => {
    let fail = true
    const offChange = vi.fn()
    const realtime: RealtimeService = {
      ...fakeRealtime(),
      onConnectionChange(handler) {
        if (fail) throw new Error('socket not ready')
        handler('offline')
        return offChange
      },
    }
    const onError = vi.fn()
    const make = () =>
      createRoot(
        defineController((ctx) => ({ conn: createConnectionState(ctx) })),
        { queries: queryEngine(), deps: { realtime }, onError },
      )
    const broken = make()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(broken.api.conn.value).toBe('connected')

    fail = false
    const working = make()
    expect(working.api.conn.value).toBe('offline')
    broken.dispose()
    working.dispose()
    expect(offChange).toHaveBeenCalledTimes(1)
  })

  test('a transport whose onConnectionChange returns no unsubscribe still disposes cleanly', () => {
    const realtime = {
      ...fakeRealtime(),
      onConnectionChange: () => undefined,
    } as unknown as RealtimeService
    const onError = vi.fn()
    const root = createRoot(
      defineController((ctx) => ({ conn: createConnectionState(ctx) })),
      { queries: queryEngine(), deps: { realtime }, onError },
    )
    root.dispose()
    expect(onError).not.toHaveBeenCalled()
  })
})
