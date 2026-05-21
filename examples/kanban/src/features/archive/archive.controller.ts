/**
 * Archive feature — cursor-paginated history of archived cards for the
 * active board.
 *
 * Library primitive demonstrated:
 *  - `defineInfiniteQuery` with cursor-based pagination (`pageParam` is the
 *    next offset; `null` when exhausted).
 *  - `flat` convenience signal — `itemsOf` flattens pages into items so the
 *    view doesn't iterate pages itself.
 *  - `useSuspendOnHidden(root)` is applied at the React entry; the archive
 *    drawer pauses polling along with everything else.
 *
 * Restoration is a serial mutation that surgically removes a card from the
 * archive pages cache after success.
 */

import { type Ctx, defineController, defineInfiniteQuery, effect } from '@kontsedal/olas-core'
import type { ArchivePage, Card } from '../../api'
import { activeBoardScope, activityScope, notificationsScope } from '../../scopes'
import { boardQuery } from '../board/board.query'

export const archiveQuery = defineInfiniteQuery<[string], number, ArchivePage, Card>({
  // Note: infinite queries don't propagate cross-tab in v1 (SPEC §13.2).
  queryId: 'archive',
  key: (boardId: string) => [boardId],
  fetcher: ({ pageParam, signal, deps }, boardId: string) =>
    deps.api.getArchive(boardId, pageParam, signal),
  initialPageParam: 0,
  getNextPageParam: (last) => last.nextCursor,
  itemsOf: (page) => page.items,
  staleTime: 30_000,
})

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`

export const archiveController = defineController(
  (ctx: Ctx) => {
    const { activeBoardId } = ctx.inject(activeBoardScope)
    const activity = ctx.inject(activityScope)
    const notifications = ctx.inject(notificationsScope)

    const sub = ctx.use(archiveQuery, () => [activeBoardId.value])

    const restore = ctx.mutation<{ cardId: string; columnId: string }, void>({
      name: 'restoreCard',
      concurrency: 'serial',
      mutate: async (vars, signal) => {
        const card = await ctx.deps.api.restoreCard(
          activeBoardId.peek(),
          vars.cardId,
          vars.columnId,
          signal,
        )
        // Surgically drop the restored card from the archive pages cache.
        archiveQuery.setData(activeBoardId.peek(), (prev) =>
          (prev ?? []).map((page) => ({
            ...page,
            items: page.items.filter((c) => c.id !== vars.cardId),
          })),
        )
        // Patch the live board cache so the card reappears in the chosen column.
        boardQuery.setData(activeBoardId.peek(), (prev) =>
          prev
            ? {
                ...prev,
                cards: { ...prev.cards, [card.id]: card },
                columns: prev.columns.map((c) =>
                  c.id === vars.columnId
                    ? { ...c, cardIds: [card.id, ...c.cardIds.filter((id) => id !== card.id)] }
                    : c,
                ),
              }
            : (prev as never),
        )
      },
      onSuccess: (_r, vars) =>
        activity.emit({
          id: uid(),
          ts: Date.now(),
          kind: 'restore',
          text: `Restored a card to ${vars.columnId}`,
        }),
      onError: (err) =>
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Restore failed',
          message: err instanceof Error ? err.message : String(err),
        }),
    })

    return { sub, restore }
  },
  { name: 'archive' },
)
