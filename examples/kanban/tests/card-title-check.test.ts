/**
 * The card form's async unique-title check.
 *
 * It is wired through `createZodForm`'s `extraValidators`, so its message
 * lands on the title field's own `errors` and its progress on
 * `isValidating`, next to the schema's rules. No DOM: the controller alone.
 */

import { describe, expect, test } from 'vitest'
import { createKanbanRoot, flush } from './helpers'

/** Past the validator's 400 ms debounce, plus the fake API's zero latency. */
const settleDebounce = () => new Promise<void>((r) => setTimeout(r, 450))

describe('card title check', () => {
  test('a title another card on the board has is reported on the title field, and a free one clears it', async () => {
    const { root, api, dispose } = createKanbanRoot()
    api.setLatency(0)
    try {
      await root.api.board.board.firstValue()
      const board = root.api.board.board.data.peek()
      const [first, second] = board?.columns[0]?.cardIds ?? []
      if (first === undefined || second === undefined)
        throw new Error('seed column needs two cards')
      const taken = board?.cards[second]?.title
      if (taken === undefined) throw new Error('seed card has no title')

      root.api.board.openCard(first)
      await flush()
      const title = root.api.cardDetail.form.fields.title

      title.set(taken)
      expect(title.isValidating.value).toBe(true)
      await settleDebounce()
      await flush()
      expect(title.errors.value).toContain('Title is already used on this board')
      expect(title.isValidating.value).toBe(false)
      expect(root.api.cardDetail.form.isValid.value).toBe(false)

      title.set(`${taken} (renamed)`)
      await settleDebounce()
      await flush()
      expect(title.errors.value).toEqual([])
      expect(root.api.cardDetail.form.isValid.value).toBe(true)
    } finally {
      dispose()
    }
  })
})
