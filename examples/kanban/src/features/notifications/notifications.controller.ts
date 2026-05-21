/**
 * Notifications feature. Subscribes to the notifications emitter and keeps
 * a capped queue of active toasts. Auto-dismiss after `TIMEOUT_MS` unless
 * the toast carries an explicit retry action.
 */

import { type Ctx, defineController, signal } from '@kontsedal/olas-core'
import { type NotificationEvent, notificationsScope } from '../../scopes'

const CAP = 4
const TIMEOUT_MS = 4500

export const notificationsController = defineController(
  (ctx: Ctx) => {
    const emitter = ctx.inject(notificationsScope)
    const queue = signal<NotificationEvent[]>([])
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const dismiss = (id: string): void => {
      const t = timers.get(id)
      if (t !== undefined) {
        clearTimeout(t)
        timers.delete(id)
      }
      queue.update((q) => q.filter((e) => e.id !== id))
    }

    ctx.on(emitter, (ev) => {
      queue.update((q) => [...q.slice(-(CAP - 1)), ev])
      // Errors that carry a retry stay until dismissed; others auto-dismiss.
      if (ev.retry === undefined) {
        timers.set(
          ev.id,
          setTimeout(() => dismiss(ev.id), TIMEOUT_MS),
        )
      }
    })

    ctx.onDispose(() => {
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    })

    return { queue, dismiss }
  },
  { name: 'notifications' },
)
