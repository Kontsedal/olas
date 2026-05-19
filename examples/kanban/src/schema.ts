// Card form — Zod schema + a thin wrapper around `formFromZod`.
//
// As of the typed-formFromZod change in @olas/zod, `formFromZod(ctx, schema)`
// returns a *structurally-precise* Form whose leaves match the schema —
// `form.fields.title.value` is `string`, `form.fields.subtasks.add({ … })`
// accepts the exact item shape. The hand-rolled `CardForm = Form<{…}>` type
// is no longer needed.

import type { Ctx } from '@olas/core'
import { formFromZod, type ZodToLeaf } from '@olas/zod'
import { z } from 'zod'
import type { Card } from './api'

export const subtaskSchema = z.object({
  text: z.string().min(1, 'Subtask cannot be empty'),
  done: z.boolean(),
})

export const prioritySchema = z.enum(['low', 'med', 'high'])

export const cardSchema = z.object({
  title: z.string().min(1, 'Title is required').max(80, 'Too long'),
  description: z.string().max(500, 'Too long'),
  priority: prioritySchema,
  /** Empty string OR ISO date — empty is friendlier for the `<input type="date">`. */
  dueDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use YYYY-MM-DD').optional(),
  subtasks: z.array(subtaskSchema).min(1, 'Add at least one subtask'),
})

export type CardFormValue = z.infer<typeof cardSchema>

/** Inferred from the schema — no hand-written shape. */
export type CardForm = ReturnType<typeof buildCardForm>
/** Inferred subtask leaf form — used by `<SubtasksRow array={...}>` props. */
export type SubtaskForm = ZodToLeaf<typeof subtaskSchema>

export function buildCardForm(ctx: Ctx, initials?: Partial<CardFormValue>) {
  return formFromZod(ctx, cardSchema, initials !== undefined ? { initials } : undefined)
}

export function cardToFormInitials(card: Card): Partial<CardFormValue> {
  return {
    title: card.title,
    description: card.description,
    priority: card.priority,
    dueDate: card.dueDate ?? '',
    subtasks: card.subtasks,
  }
}

export function formValueToCard(id: string, value: CardFormValue): Card {
  return {
    id,
    title: value.title,
    description: value.description,
    priority: value.priority,
    dueDate: value.dueDate && value.dueDate !== '' ? value.dueDate : null,
    subtasks: value.subtasks,
  }
}

/** Form initials when creating a brand-new card. */
export const NEW_CARD_INITIALS: Partial<CardFormValue> = {
  title: '',
  description: '',
  priority: 'med',
  dueDate: '',
  subtasks: [{ text: '', done: false }],
}
