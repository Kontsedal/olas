// Card form — Zod schema + a strongly-typed wrapper around `formFromZod`.
//
// `formFromZod` returns a union per leaf (Field | Form | FieldArray) because
// Zod schemas are runtime-typed. The `CardForm` type below pins each leaf to
// its exact runtime shape so consumers can read `form.fields.title.value`
// without casts. `buildCardForm(ctx, initials?)` performs the single cast
// internally — every other reference is fully type-safe.

import type { Ctx, Field, FieldArray, Form } from '@olas/core'
import { formFromZod } from '@olas/zod'
import { z } from 'zod'
import type { Card, Priority } from './api'

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

/** Per-subtask form: text + done. */
export type SubtaskForm = Form<{
  text: Field<string>
  done: Field<boolean>
}>

/** The whole card form, typed exactly. */
export type CardForm = Form<{
  title: Field<string>
  description: Field<string>
  priority: Field<Priority>
  dueDate: Field<string>
  subtasks: FieldArray<SubtaskForm>
}>

/**
 * Build a `CardForm` from the shared `cardSchema`. Performs the single cast
 * needed to specialize `formFromZod`'s untyped leaf union into the precise
 * `CardForm` shape — every consumer downstream is fully typed.
 */
export function buildCardForm(ctx: Ctx, initials?: Partial<CardFormValue>): CardForm {
  return formFromZod(
    ctx,
    cardSchema,
    initials !== undefined ? { initials } : undefined,
  ) as unknown as CardForm
}

/** Convert a `Card` (db shape, nullable dueDate) to form initials (empty string). */
export function cardToFormInitials(card: Card): Partial<CardFormValue> {
  return {
    title: card.title,
    description: card.description,
    priority: card.priority,
    dueDate: card.dueDate ?? '',
    subtasks: card.subtasks,
  }
}

/** Convert form value back to a `Card` shape — applies the dueDate empty/null mapping. */
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
