/**
 * Subtask list keys.
 *
 * `SubtasksRow` renders a `FieldArray` with a delete button per row. Under
 * `key={idx}` a removal renumbers every later row, so React matches the
 * survivor's data onto the removed row's DOM node and deletes the LAST node
 * instead. The text still looks right — the inputs are controlled — while
 * the caret, the selection and any IME composition stay behind on the wrong
 * element.
 *
 * This test watches DOM node identity, which is the thing that actually
 * moves.
 */

import { OlasProvider } from '@kontsedal/olas-react'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { SubtasksRow } from '../src/features/card-detail/SubtasksRow'
import { createKanbanRoot, flush } from './helpers'

describe('SubtasksRow keys', () => {
  test('removing a row keeps every survivor on its own DOM node', async () => {
    const { root, dispose } = createKanbanRoot()
    try {
      const array = root.api.cardDetail.form.fields.subtasks
      act(() => {
        array.add({ text: 'first', done: false })
        array.add({ text: 'second', done: false })
        array.add({ text: 'third', done: false })
      })
      await flush()

      render(
        <OlasProvider root={root}>
          <SubtasksRow />
        </OlasProvider>,
      )

      const textOf = (el: Element) => (el as HTMLInputElement).value
      const inputs = () => screen.getAllByPlaceholderText('What needs doing?')
      expect(inputs().map(textOf)).toEqual(['first', 'second', 'third'])

      const secondNode = inputs()[1]
      const thirdNode = inputs()[2]

      // Drop the first row.
      act(() => {
        array.remove(0)
      })
      await flush()

      const after = inputs()
      expect(after.map(textOf)).toEqual(['second', 'third'])
      // The surviving rows kept the nodes they already had. With index keys
      // these would be the OLD first and second nodes instead.
      expect(after[0]).toBe(secondNode)
      expect(after[1]).toBe(thirdNode)
    } finally {
      dispose()
    }
  })
})
