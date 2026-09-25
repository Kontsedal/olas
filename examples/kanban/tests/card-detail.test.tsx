/**
 * Card-detail suspend state.
 *
 * The panel's details sit in a `<SuspendOnUnmount>` wrapper, and the head's
 * state tag renders the controller's `isPaused`. These tests watch the tag
 * and the signal together: collapsing the details and closing the card both
 * unmount the wrapper, which suspends the controller, and expanding resumes
 * it with the form's draft still in place.
 */

import { OlasProvider } from '@kontsedal/olas-react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { CardDetail } from '../src/features/card-detail/CardDetail'
import { createKanbanRoot, flush } from './helpers'

const openFirstCard = async (root: ReturnType<typeof createKanbanRoot>['root']) => {
  await root.api.board.board.firstValue()
  const board = root.api.board.board.data.peek()
  const cardId = board?.columns[0]?.cardIds[0]
  if (cardId === undefined) throw new Error('seed board has no card')
  act(() => root.api.board.openCard(cardId))
  await flush()
  return cardId
}

describe('CardDetail suspend state', () => {
  test('collapsing the details suspends the controller, and expanding resumes it', async () => {
    const { root, api, dispose } = createKanbanRoot()
    api.setLatency(0)
    try {
      render(
        <OlasProvider root={root}>
          <CardDetail />
        </OlasProvider>,
      )
      await openFirstCard(root)

      expect(root.api.cardDetail.isPaused.value).toBe(false)
      expect(screen.getByText('Live')).toBeTruthy()

      const description = screen.getByPlaceholderText('Add a description…')
      fireEvent.change(description, { target: { value: 'an unsaved draft' } })

      fireEvent.click(screen.getByRole('button', { name: 'Collapse details' }))
      expect(root.api.cardDetail.isPaused.value).toBe(true)
      expect(screen.getByText('Suspended')).toBeTruthy()
      expect(screen.queryByPlaceholderText('Add a description…')).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'Expand details' }))
      expect(root.api.cardDetail.isPaused.value).toBe(false)
      expect(screen.getByText('Live')).toBeTruthy()
      // The controller was suspended, not disposed, so the draft survived.
      const restored = screen.getByPlaceholderText('Add a description…') as HTMLTextAreaElement
      expect(restored.value).toBe('an unsaved draft')
    } finally {
      dispose()
    }
  })

  test('closing the card suspends the controller, and opening one resumes it', async () => {
    const { root, api, dispose } = createKanbanRoot()
    api.setLatency(0)
    try {
      render(
        <OlasProvider root={root}>
          <CardDetail />
        </OlasProvider>,
      )
      const cardId = await openFirstCard(root)
      expect(root.api.cardDetail.isPaused.value).toBe(false)

      act(() => root.api.cardDetail.close())
      expect(screen.queryByText('Live')).toBeNull()
      expect(root.api.cardDetail.isPaused.value).toBe(true)

      act(() => root.api.board.openCard(cardId))
      await flush()
      expect(root.api.cardDetail.isPaused.value).toBe(false)
      expect(screen.getByText('Live')).toBeTruthy()
    } finally {
      dispose()
    }
  })
})
