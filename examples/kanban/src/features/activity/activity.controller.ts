/**
 * Activity feed feature. Holds a bounded ring buffer of `ActivityEvent`s,
 * fed by:
 *
 *  - `ctx.on(activityScope, handler)` — local events emitted by other
 *    features (move, save, archive, comment, error).
 *  - `useRealtimePatcher` already handled in `board.controller.ts` for
 *    remote-actor events; those are forwarded into the same emitter so the
 *    UI doesn't care about the source.
 */

import { type Ctx, defineController, signal } from '@kontsedal/olas-core'
import { type ActivityEvent, activityScope } from '../../scopes'

const CAP = 40

export const activityController = defineController(
  (ctx: Ctx) => {
    const emitter = ctx.inject(activityScope)
    const events = signal<ActivityEvent[]>([])

    ctx.on(emitter, (ev) => {
      events.update((arr) => [ev, ...arr].slice(0, CAP))
    })

    return { events, clear: () => events.set([]) }
  },
  { name: 'activity' },
)
