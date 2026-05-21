/**
 * Zod schemas for the card form + `AmbientDeps` augmentation.
 *
 * The card form is built via `formFromZod` so leaf validators, FieldArray
 * walking, and TS inference all come from the same schema. An async
 * `debouncedValidator` for "title is unique on this board" attaches to
 * the title field at controller-construction time (see `card-detail`).
 */

import type { EntitiesPlugin } from '@kontsedal/olas-entities'
import { z } from 'zod'
import type { NotificationEvent } from '../scopes'
import type { Broadcaster } from './broadcast'
import type { Api } from './fake-api'

/**
 * Mutable ref pattern — gives `root.onError` a way to call the notifications
 * emitter that lives *inside* the controller tree. `appController` swaps the
 * `.current` slot during construction and resets it on dispose.
 */
export type NotifyRef = { current: (event: NotificationEvent) => void }

export const prioritySchema = z.enum(['low', 'med', 'high', 'urgent'])

export const subtaskSchema = z.object({
  text: z.string().min(1, 'Subtask cannot be empty'),
  done: z.boolean(),
})

export const cardFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(80, 'Too long'),
  description: z.string().max(800, 'Too long'),
  priority: prioritySchema,
  /** Empty string OR ISO `YYYY-MM-DD` — empty plays nicer with `<input type="date">`. */
  dueDate: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use YYYY-MM-DD')
    .optional(),
  assigneeIds: z.array(z.string()),
  labelIds: z.array(z.string()),
  subtasks: z.array(subtaskSchema),
})

export type CardFormValue = z.infer<typeof cardFormSchema>

/** Ambient deps augmentation — picked up by all controllers via `ctx.deps`. */
declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
    broadcaster: Broadcaster
    realtime: Broadcaster['realtime']
    /** Tab identity — embedded in every published realtime event. */
    tabId: string
    /**
     * Entities plugin handle. Exposed on deps so any controller can read
     * `ctx.deps.entities.signal(UserEntity, id)` without threading the
     * plugin through scopes.
     */
    entities: EntitiesPlugin
    /**
     * Mutable bridge populated by `appController` so the root-level `onError`
     * handler can call the notifications emitter that lives inside the tree.
     */
    notifyRef: NotifyRef
  }
}
