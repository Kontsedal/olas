/**
 * Two roots sharing a BroadcastChannel hub stand in for two browser tabs.
 * A move on tab A replays the cache write on tab B via the crossTab plugin,
 * AND drops an "another tab moved a card" activity entry on tab B via the
 * realtime patcher.
 */

import { describe, expect, test } from 'vitest'
import { createKanbanRoot, createTestBus, flush } from './helpers'

describe('cross-tab + realtime convergence', () => {
  test('tab B activity feed reflects a move that happened on tab A', async () => {
    const bus = createTestBus()
    const a = createKanbanRoot({ channelFactory: bus.factory, tabId: 'tabA' })
    const b = createKanbanRoot({ channelFactory: bus.factory, tabId: 'tabB' })
    try {
      await a.root.board.board.firstValue()
      await b.root.board.board.firstValue()

      const board = a.root.board.board.data.peek()!
      const todo = board.columns.find((c) => c.id === 'b1_todo')!
      const cardId = todo.cardIds[0]!

      await a.root.board.moveCard.run({
        cardId,
        fromColumnId: todo.id,
        toColumnId: 'b1_done',
        toIndex: 0,
      })
      await flush()
      await new Promise((r) => setTimeout(r, 100))

      const activityB = b.root.activity.events.peek()
      const hasRemote = activityB.some((e) => e.isRemote === true)
      expect(hasRemote).toBe(true)
    } finally {
      a.dispose()
      b.dispose()
    }
  })
})
