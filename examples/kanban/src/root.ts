/**
 * Root construction. The single place that knows about both the *deps* and
 * the *plugins* — keeps every feature controller free of bootstrap shape.
 *
 *  - `entitiesPlugin([UserEntity, LabelEntity])` walks every query write
 *    looking for entity-shaped objects.
 *  - `crossTabPlugin({ channelName })` mirrors cache writes across browser
 *    tabs of the same origin.
 *  - `onError` routes uncaught controller errors to the notifications
 *    emitter via a mutable `notifyRef` bridge that `appController` swaps.
 */

import { createRoot } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { type Api, type Broadcaster, createBroadcaster, createFakeApi } from './api'
import type { NotifyRef } from './api/schema'
import { appController } from './app.controller'
import { createEntitiesPlugin } from './entities'

export function createAppRoot(opts?: { api?: Api; broadcaster?: Broadcaster }) {
  const api = opts?.api ?? createFakeApi()
  const broadcaster = opts?.broadcaster ?? createBroadcaster()
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
    },
    plugins: [entities, crossTabPlugin({ channelName: 'olas-kanban-cache' })],
    onError: (err, context) => {
      const message = err instanceof Error ? err.message : String(err)
      notifyRef.current({
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        kind: 'error',
        title: 'Something went wrong',
        message: `[${context.kind}${context.controllerPath.length > 0 ? ' / ' + context.controllerPath.join('/') : ''}] ${message}`,
      })
    },
  })

  return { root, broadcaster, api }
}

export type AppRoot = ReturnType<typeof createAppRoot>['root']
