/**
 * Board feature — drag-drop mutations, optimistic rollback, latest-wins
 * search, serial reorder. Mirrors the testability claim made by the spec.
 */

import { describe, expect, test } from 'vitest'
import { createKanbanRoot, flush } from './helpers'

describe('boardController — mutations', () => {
  test('moveCard (parallel) applies an optimistic patch and snaps back on failure', async () => {
    const { root, api, dispose } = createKanbanRoot()
    try {
      // Wait for initial board fetch.
      await root.api.board.board.firstValue()
      const id = root.api.boards.activeBoardId.peek()
      const board0 = root.api.board.board.data.peek()!
      const todo = board0.columns.find((c) => c.id === 'b1_todo')!
      const cardId = todo.cardIds[0]!

      api.failNextWrite = true
      await root.api.board.moveCard
        .run({
          cardId,
          fromColumnId: todo.id,
          toColumnId: 'b1_done',
          toIndex: 0,
        })
        .catch(() => null)
      await flush()

      const after = root.api.board.board.data.peek()!
      const todoAfter = after.columns.find((c) => c.id === todo.id)!
      // Rolled back into the original column.
      expect(todoAfter.cardIds.includes(cardId)).toBe(true)
      void id
    } finally {
      dispose()
    }
  })

  test('reorderColumn (serial) processes runs in order, even when fired in parallel', async () => {
    const { root, dispose } = createKanbanRoot()
    try {
      await root.api.board.board.firstValue()
      const data = root.api.board.board.data.peek()!
      const col = data.columns[0]!
      const original = col.cardIds.slice()
      // Reverse and then re-reverse — serial guarantees the second wins.
      const reversed = original.slice().reverse()
      const reorder1 = root.api.board.reorderColumn.run({ columnId: col.id, cardIds: reversed })
      const reorder2 = root.api.board.reorderColumn.run({ columnId: col.id, cardIds: original })
      await Promise.all([reorder1, reorder2])
      await flush()
      const after = root.api.board.board.data.peek()!
      const colAfter = after.columns.find((c) => c.id === col.id)!
      expect(colAfter.cardIds).toEqual(original)
    } finally {
      dispose()
    }
  })

  test('search (latest-wins) settles to the most recent input', async () => {
    const { root, dispose } = createKanbanRoot()
    try {
      await root.api.board.board.firstValue()
      // Fire several searches rapidly — only the last matters.
      root.api.board.searchInputRaw.set('a')
      root.api.board.searchInputRaw.set('ab')
      root.api.board.searchInputRaw.set('abc')
      // Debounce window (250ms) + mutation latency (3× api latency = 180ms by default).
      await new Promise((r) => setTimeout(r, 750))
      const hits = root.api.board.searchHits.peek()
      // Either null (no matches) or matches restricted to query 'abc'.
      if (hits !== null) expect(hits.q).toBe('abc')
    } finally {
      dispose()
    }
  })
})
