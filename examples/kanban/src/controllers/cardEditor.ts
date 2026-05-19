// Card editor controller.
//
// Constructed lazily via `boardController.openEditor(target)`. Two modes:
//
//  - `{ mode: 'edit', card }`  — load the existing card's fields, save with
//                                `api.saveCard` (id stays put).
//  - `{ mode: 'create', columnId }` — start blank, save with `api.createCard`
//                                     which mints an id and appends to the
//                                     target column.
//
// In both cases the editor injects `currentBoardScope` + `activityScope` from
// its parent (the board controller) — neither flows in via props. Spec §10.3.

import { type Ctx, defineController } from '@kontsedal/olas-core'
import type { Card, NewCard } from '../api'
import { boardQuery } from '../query'
import { buildCardForm, type CardFormValue, cardToFormInitials, NEW_CARD_INITIALS } from '../schema'
import { activityScope, currentBoardScope } from '../scopes'

export type CardEditorTarget = { mode: 'edit'; card: Card } | { mode: 'create'; columnId: string }

export type CardEditorProps = {
  target: CardEditorTarget
}

export const cardEditorController = defineController(
  (ctx: Ctx, props: CardEditorProps) => {
    const board = ctx.inject(currentBoardScope)
    const activity = ctx.inject(activityScope)
    const { target } = props

    const form = buildCardForm(
      ctx,
      target.mode === 'edit' ? cardToFormInitials(target.card) : NEW_CARD_INITIALS,
    )

    const save = ctx.mutation<void, Card>({
      name: target.mode === 'edit' ? 'saveCard' : 'createCard',
      mutate: async (_: void, signal) => {
        form.markAllTouched()
        const ok = await form.validate()
        if (!ok) throw new Error('Invalid card form')
        const v = form.value.value as CardFormValue

        const newCardBody: NewCard = {
          title: v.title,
          description: v.description,
          priority: v.priority,
          dueDate: v.dueDate && v.dueDate !== '' ? v.dueDate : null,
          subtasks: v.subtasks,
        }

        if (target.mode === 'edit') {
          const saved = await ctx.deps.api.saveCard(
            board.id,
            { ...newCardBody, id: target.card.id },
            signal,
          )
          boardQuery.setData(board.id, (prev) => {
            if (!prev) throw new Error('saveCard before board loaded')
            return { ...prev, cards: { ...prev.cards, [saved.id]: saved } }
          })
          return saved
        }

        // Create mode: api mints the id and appends to the target column.
        const saved = await ctx.deps.api.createCard(board.id, target.columnId, newCardBody, signal)
        boardQuery.setData(board.id, (prev) => {
          if (!prev) throw new Error('createCard before board loaded')
          return {
            ...prev,
            cards: { ...prev.cards, [saved.id]: saved },
            columns: prev.columns.map((c) =>
              c.id === target.columnId ? { ...c, cardIds: [saved.id, ...c.cardIds] } : c,
            ),
          }
        })
        return saved
      },
      onSuccess: (saved) => {
        boardQuery.invalidate(board.id)
        activity.emit({
          ts: Date.now(),
          kind: 'save',
          text:
            target.mode === 'edit'
              ? `Saved “${saved.title}”`
              : `Created “${saved.title}” in ${target.columnId}`,
        })
      },
      onError: (err) => {
        activity.emit({
          ts: Date.now(),
          kind: 'error',
          text: `${target.mode === 'edit' ? 'Save' : 'Create'} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        })
      },
    })

    return { form, save, mode: target.mode, boardId: board.id }
  },
  { name: 'cardEditor' },
)
