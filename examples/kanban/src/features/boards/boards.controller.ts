/**
 * Boards-list controller. Owns:
 *  - The list query (cross-tab synced).
 *  - The "currently active" board id (a Signal, seeded from prefs and
 *    written back via the preferences scope).
 *  - `activeBoardScope` provision for descendants.
 *
 * The sidebar reads `boards`; the main pane reads `activeBoardId`.
 */

import { type Ctx, defineController, effect, signal } from '@kontsedal/olas-core'
import { preferencesScope } from '../../scopes'
import { boardsListQuery } from './boards.query'

export const boardsController = defineController(
  (ctx: Ctx) => {
    const prefs = ctx.inject(preferencesScope)
    const list = ctx.use(boardsListQuery)

    // The active board id. Seeded from the persisted preference; when the
    // list resolves we validate the seed and fall back to the first board
    // if it isn't there (e.g. the persisted id no longer exists).
    const activeBoardId = signal<string>(prefs.prefs.peek().lastBoardId ?? 'b1')

    // Once the boards list arrives, validate / pick.
    const cleanupAdopt = effect(() => {
      const all = list.data.value
      if (all === undefined || all.length === 0) return
      const current = activeBoardId.peek()
      if (!all.some((b) => b.id === current)) {
        activeBoardId.set(all[0]!.id)
      }
    })
    ctx.onDispose(cleanupAdopt)

    // Write the active id back to prefs so reloads land on the same board.
    ctx.effect(() => {
      const id = activeBoardId.value
      prefs.setLastBoardId(id)
    })

    const setActive = (id: string): void => {
      if (activeBoardId.peek() === id) return
      activeBoardId.set(id)
    }

    // NOTE: activeBoardScope is provided by `appController` so siblings of
    // `boardsController` (board, card-detail, comments, search…) can inject
    // it. Provisions only flow to descendants — providing it here would
    // hide it from those siblings.

    return {
      list,
      activeBoardId,
      setActive,
    }
  },
  { name: 'boards' },
)
