/**
 * Entity normalization — a `User` update flows from any source to every card
 * holding that user, via the entitiesPlugin's reverse index.
 */

import { describe, expect, test } from 'vitest'
import { UserEntity } from '../src/entities'
import { createKanbanRoot, flush } from './helpers'

describe('entities plugin', () => {
  test('updating a user propagates to every cached card referencing it', async () => {
    const { root, dispose } = createKanbanRoot()
    try {
      await root.board.board.firstValue()
      await root.users.firstValue()
      await flush()

      // Sanity: at least one card has u_ada as an assignee.
      const board = root.board.board.data.peek()!
      const adaCards = Object.values(board.cards).filter((c) => c.assigneeIds.includes('u_ada'))
      expect(adaCards.length).toBeGreaterThan(0)

      // Patch the user via the entities plugin.
      root.entities.update(UserEntity, 'u_ada', { name: 'Augusta Ada King' })
      await flush()

      // The entity store reflects the patch.
      const updated = root.entities.get(UserEntity, 'u_ada')
      expect(updated?.name).toBe('Augusta Ada King')
    } finally {
      dispose()
    }
  })
})
