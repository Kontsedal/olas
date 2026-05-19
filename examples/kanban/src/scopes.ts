// Cross-tree typed data slots (spec §10.3).
//
// `currentBoardScope` lets a descendant controller (e.g. the card editor)
// learn which board it's operating in without taking `boardId` in props from
// every ancestor along the way.
//
// `activityScope` carries an emitter — so any descendant can emit into the
// shared activity feed without prop-drilling the emitter handle. Demonstrates
// that scopes can carry rich values (emitters, signals, services), not just
// strings.

import { defineScope, type Emitter } from '@kontsedal/olas-core'

export const currentBoardScope = defineScope<{ id: string }>({ name: 'currentBoard' })

export type ActivityEvent = {
  ts: number
  kind: 'move' | 'save' | 'error'
  text: string
}

export const activityScope = defineScope<Emitter<ActivityEvent>>({ name: 'activity' })
