/**
 * The tracing plugin: a span per fetch and mutate attempt, read through the
 * `Traces` scope it provides.
 */

import { describe, expect, test } from 'vitest'
import { Traces } from '../src/tracing'
import { createKanbanRoot, flush } from './helpers'

describe('tracingPlugin', () => {
  test('records a span for the board fetch and for a failed mutation', async () => {
    const { root, api, dispose } = createKanbanRoot()
    try {
      await root.api.board.board.firstValue()
      const traces = root.inject(Traces)
      const fetches = traces.spans.value.filter((s) => s.kind === 'fetch')
      expect(fetches.length).toBeGreaterThan(0)
      expect(fetches.every((s) => s.outcome === 'ok' && s.durationMs >= 0)).toBe(true)

      const board = root.api.board.board.data.peek()
      const todo = board?.columns.find((c) => c.id === 'b1_todo')
      const cardId = todo?.cardIds[0]
      if (todo === undefined || cardId === undefined) throw new Error('fixture changed')
      api.failNextWrite = true
      await root.api.board.moveCard
        .run({ cardId, fromColumnId: todo.id, toColumnId: 'b1_done', toIndex: 0 })
        .catch(() => null)
      await flush()
      const mutates = traces.spans.value.filter((s) => s.kind === 'mutate')
      expect(mutates.at(-1)?.outcome).toBe('error')
    } finally {
      dispose()
    }
  })
})
