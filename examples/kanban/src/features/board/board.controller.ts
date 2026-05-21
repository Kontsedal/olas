/**
 * Board feature — the kanban grid. Owns the per-board view and three
 * different mutation concurrency modes:
 *
 *  - `moveCard`        — `parallel`: every drag can race; the optimistic
 *                        snapshot auto-rolls back on non-abort errors.
 *  - `reorderColumn`   — `serial`: queued runs apply in order so two rapid
 *                        reorders on the same column never interleave.
 *  - `applyFilter`     — `latest-wins`: superseded by the next `run(...)`
 *                        when the user keeps typing.
 *
 * Also demonstrated here:
 *  - `selection<string>()` for bulk move.
 *  - `signal` + `computed` for filter intersection.
 *  - `throttled` for streaming drag progress over the realtime channel.
 *  - `useRealtimePatcher` for receiving moves from other tabs.
 *  - `entitiesPlugin` writes — patching a User propagates across cards.
 *  - `defineScope` provisions: currentBoard, selectedCard.
 */

import {
  type Ctx,
  computed,
  debounced,
  defineController,
  selection,
  signal,
  throttled,
} from '@kontsedal/olas-core'
import { useRealtimePatcher } from '@kontsedal/olas-realtime'
import type { Board, Card, Column, Priority, RealtimeEvent, SearchResults } from '../../api'
import { REALTIME_CHANNEL } from '../../api'
import { UserEntity } from '../../entities'
import {
  type ActivityEvent,
  activeBoardScope,
  activityScope,
  notificationsScope,
} from '../../scopes'
import { boardQuery } from './board.query'

export type MoveVars = {
  cardId: string
  fromColumnId: string
  toColumnId: string
  toIndex: number
}

const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const boardController = defineController(
  (ctx: Ctx) => {
    const { activeBoardId } = ctx.inject(activeBoardScope)
    const activity = ctx.inject(activityScope)
    const notifications = ctx.inject(notificationsScope)

    // Reactive key thunk — switching boards via the sidebar refetches under
    // a new entry without re-mounting boardController.
    const board = ctx.use(boardQuery, () => [activeBoardId.value])

    // ───────── Selected card (right-hand detail pane) ─────────

    const selectedCardId = signal<string | null>(null)
    const openCard = (id: string): void => selectedCardId.set(id)
    const closeCard = (): void => selectedCardId.set(null)
    // selectedCardScope is provided by `appController` using these handles
    // so siblings (cardDetail, comments) can inject. See `app.controller.ts`.

    // ───────── Multi-select (bulk move) ─────────

    const sel = selection<string>()

    // Switching boards closes the detail panel — selection is per-board.
    ctx.effect(() => {
      activeBoardId.value
      selectedCardId.set(null)
      sel.clear()
    })

    // ───────── Search + filters ─────────
    //
    // `searchInputRaw` is the user's literal keystrokes. `debounced(...)`
    // produces a settled value (250 ms) which the effect feeds into the
    // latest-wins applyFilter mutation. Filter chips (priority / label /
    // assignee) are plain Sets the view writes to.

    const searchInputRaw = signal('')
    const searchInput = debounced(searchInputRaw, 250)
    const searchHits = signal<SearchResults | null>(null)
    const isSearching = signal(false)
    const selectedPriorities = signal<ReadonlySet<Priority>>(new Set())
    const selectedLabelIds = signal<ReadonlySet<string>>(new Set())
    const selectedAssigneeIds = signal<ReadonlySet<string>>(new Set())

    const applyFilter = ctx.mutation<{ q: string }, SearchResults>({
      name: 'applyFilter',
      concurrency: 'latest-wins',
      mutate: async (vars, signal) => {
        isSearching.set(true)
        try {
          const r = await ctx.deps.api.search(activeBoardId.peek(), vars.q, signal)
          if (signal.aborted) throw new DOMException('Superseded', 'AbortError')
          return r
        } finally {
          if (!signal.aborted) isSearching.set(false)
        }
      },
      onSuccess: (r) => {
        searchHits.set(r.q.trim() === '' ? null : r)
      },
    })

    // Bridge debounced search → latest-wins mutation.
    ctx.effect(() => {
      const q = searchInput.value
      void applyFilter.run({ q }).catch(() => {
        /* aborts are expected; ignore */
      })
    })

    /**
     * Final visible-card predicate. Combines the search hit set with the
     * three client-side filter chips. `null` means "no active filter,
     * show everything"; a Set is the explicit allow list.
     */
    const filterMatches = computed<Set<string> | null>(() => {
      const hits = searchHits.value
      const prs = selectedPriorities.value
      const lbs = selectedLabelIds.value
      const ass = selectedAssigneeIds.value
      const hasChips = prs.size > 0 || lbs.size > 0 || ass.size > 0
      if (hits === null && !hasChips) return null

      const candidates = hits === null ? null : new Set(hits.cardIds)
      const data = board.data.value
      if (data === undefined) return candidates
      const allowed = new Set<string>()
      for (const card of Object.values(data.cards)) {
        if (candidates !== null && !candidates.has(card.id)) continue
        if (prs.size > 0 && !prs.has(card.priority)) continue
        if (lbs.size > 0 && !card.labelIds.some((id) => lbs.has(id))) continue
        if (ass.size > 0 && !card.assigneeIds.some((id) => ass.has(id))) continue
        allowed.add(card.id)
      }
      return allowed
    })

    const togglePriority = (p: Priority): void => {
      const cur = new Set(selectedPriorities.peek())
      if (cur.has(p)) cur.delete(p)
      else cur.add(p)
      selectedPriorities.set(cur)
    }
    const toggleLabel = (id: string): void => {
      const cur = new Set(selectedLabelIds.peek())
      if (cur.has(id)) cur.delete(id)
      else cur.add(id)
      selectedLabelIds.set(cur)
    }
    const toggleAssignee = (id: string): void => {
      const cur = new Set(selectedAssigneeIds.peek())
      if (cur.has(id)) cur.delete(id)
      else cur.add(id)
      selectedAssigneeIds.set(cur)
    }
    const clearFilters = (): void => {
      searchInputRaw.set('')
      selectedPriorities.set(new Set())
      selectedLabelIds.set(new Set())
      selectedAssigneeIds.set(new Set())
    }

    // ───────── Move card (parallel, optimistic with snapshot auto-rollback) ─────────

    const moveCard = ctx.mutation<MoveVars, void>({
      name: 'moveCard',
      concurrency: 'parallel',
      onMutate: (vars) =>
        boardQuery.setData(activeBoardId.peek(), (prev) => {
          if (!prev) throw new Error('moveCard before board loaded')
          return applyMove(prev, vars)
        }),
      mutate: (vars, signal) =>
        ctx.deps.api.moveCard(
          activeBoardId.peek(),
          vars.cardId,
          vars.fromColumnId,
          vars.toColumnId,
          vars.toIndex,
          signal,
        ),
      onSuccess: (_r, vars) => {
        activity.emit(makeActivity('move', `Moved card to ${vars.toColumnId}`))
        ctx.deps.broadcaster.publish({
          type: 'card.moved',
          cardId: vars.cardId,
          fromColumnId: vars.fromColumnId,
          toColumnId: vars.toColumnId,
          toIndex: vars.toIndex,
          by: ctx.deps.tabId,
        })
      },
      onError: (err, vars) => {
        // Snapshot auto-rolls back on non-abort errors. We still surface a
        // toast so the user sees what happened.
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Move failed',
          message: errMessage(err),
          retry: () => {
            void moveCard.run(vars)
          },
        })
      },
    })

    // ───────── Create card (serial) ─────────

    const createCard = ctx.mutation<{ columnId: string; title: string }, Card>({
      name: 'createCard',
      concurrency: 'serial',
      mutate: async (vars, signal) => {
        const card = await ctx.deps.api.createCard(
          activeBoardId.peek(),
          {
            columnId: vars.columnId,
            title: vars.title,
            description: '',
            priority: 'med',
            dueDate: null,
            assigneeIds: [],
            labelIds: [],
            subtasks: [],
          },
          signal,
        )
        boardQuery.setData(activeBoardId.peek(), (prev) =>
          prev
            ? {
                ...prev,
                cards: { ...prev.cards, [card.id]: card },
                columns: prev.columns.map((c) =>
                  c.id === vars.columnId ? { ...c, cardIds: [card.id, ...c.cardIds] } : c,
                ),
              }
            : (prev as never),
        )
        return card
      },
      onSuccess: (card) => {
        activity.emit(makeActivity('create', `Created "${card.title}"`))
        ctx.deps.broadcaster.publish({
          type: 'card.created',
          card,
          by: ctx.deps.tabId,
        })
        // Open the new card for editing right away — matches Linear's flow.
        openCard(card.id)
      },
      onError: (err) =>
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Create failed',
          message: errMessage(err),
        }),
    })

    // ───────── Create column (serial) ─────────

    const createColumn = ctx.mutation<{ title: string; hue?: number }, Column>({
      name: 'createColumn',
      concurrency: 'serial',
      mutate: async (vars, signal) => {
        const hue = vars.hue ?? randomColumnHue()
        const col = await ctx.deps.api.createColumn(activeBoardId.peek(), vars.title, hue, signal)
        boardQuery.setData(activeBoardId.peek(), (prev) =>
          prev ? { ...prev, columns: [...prev.columns, col] } : (prev as never),
        )
        return col
      },
      onSuccess: (col) => activity.emit(makeActivity('create', `Created column "${col.title}"`)),
      onError: (err) =>
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Create column failed',
          message: errMessage(err),
        }),
    })

    // ───────── Reorder a single column (serial) ─────────

    const reorderColumn = ctx.mutation<{ columnId: string; cardIds: string[] }, void>({
      name: 'reorderColumn',
      concurrency: 'serial',
      onMutate: (vars) =>
        boardQuery.setData(activeBoardId.peek(), (prev) => {
          if (!prev) throw new Error('reorderColumn before board loaded')
          return {
            ...prev,
            columns: prev.columns.map((c) =>
              c.id === vars.columnId ? { ...c, cardIds: vars.cardIds.slice() } : c,
            ),
          }
        }),
      mutate: (vars, signal) =>
        ctx.deps.api.reorderColumn(activeBoardId.peek(), vars.columnId, vars.cardIds, signal),
      onSuccess: (_r, vars) => activity.emit(makeActivity('move', `Reordered ${vars.columnId}`)),
      onError: (err, vars, snapshot) => {
        // Explicit rollback — even though the snapshot would auto-roll on
        // throw, the demo deliberately keeps both styles visible.
        snapshot?.rollback()
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Reorder failed',
          message: errMessage(err),
        })
      },
    })

    // ───────── Archive (serial) ─────────

    const archiveCard = ctx.mutation<{ cardId: string }, void>({
      name: 'archiveCard',
      concurrency: 'serial',
      onMutate: (vars) =>
        boardQuery.setData(activeBoardId.peek(), (prev) => {
          if (!prev) throw new Error('archiveCard before board loaded')
          return removeCard(prev, vars.cardId)
        }),
      mutate: (vars, signal) => ctx.deps.api.archiveCard(activeBoardId.peek(), vars.cardId, signal),
      onSuccess: (_r, vars) => {
        activity.emit(makeActivity('archive', 'Archived a card'))
        ctx.deps.broadcaster.publish({
          type: 'card.archived',
          cardId: vars.cardId,
          by: ctx.deps.tabId,
        })
        // Drop the archive cache so the drawer's infinite query refetches.
        // Cheap because the drawer is closed by default.
      },
      onError: (err) =>
        notifications.emit({
          id: uid(),
          kind: 'error',
          title: 'Archive failed',
          message: errMessage(err),
        }),
    })

    // ───────── Bulk move (selection helper) ─────────

    const bulkMove = async (toColumnId: string): Promise<void> => {
      const ids = [...sel.selectedIds.peek()]
      const current = board.data.peek()
      if (current === undefined || ids.length === 0) return
      await Promise.allSettled(
        ids.map((cardId) => {
          const from = current.columns.find((c) => c.cardIds.includes(cardId))
          if (!from || from.id === toColumnId) return Promise.resolve()
          return moveCard.run({
            cardId,
            fromColumnId: from.id,
            toColumnId,
            toIndex: 0,
          })
        }),
      )
      sel.clear()
    }

    // ───────── Throttled drag-progress signal ─────────

    // The view writes the *raw* drag delta to this signal as the user moves;
    // the throttled output emits at most once per 80ms — used both for the
    // ghost card position AND for broadcasting drag hints to other tabs.
    const dragPosRaw = signal<{ cardId: string; clientX: number; clientY: number } | null>(null)
    const dragPos = throttled(dragPosRaw, 80)

    // ───────── Realtime patcher — react to events from other tabs ─────────
    //
    // `useRealtimePatcher` types each handler's arg as the full event union,
    // so we narrow with a small `Variant` alias on the way in.

    type Variant<K extends RealtimeEvent['type']> = Extract<RealtimeEvent, { type: K }>

    useRealtimePatcher<RealtimeEvent>(ctx, REALTIME_CHANNEL, {
      'card.moved': (raw) => {
        const e = raw as Variant<'card.moved'>
        if (e.by === ctx.deps.tabId) return
        activity.emit({
          id: uid(),
          ts: Date.now(),
          kind: 'remote',
          isRemote: true,
          text: `Another tab moved a card to ${e.toColumnId}`,
        })
        // The cache patch itself flows via crossTabPlugin's setData replay.
        // The patcher's job here is the activity entry + any side effects
        // that the cache write alone can't produce.
      },
      'card.created': (raw) => {
        const e = raw as Variant<'card.created'>
        if (e.by === ctx.deps.tabId) return
        activity.emit({
          id: uid(),
          ts: Date.now(),
          kind: 'remote',
          isRemote: true,
          text: `Another tab created "${e.card.title}"`,
        })
      },
      'card.archived': (raw) => {
        const e = raw as Variant<'card.archived'>
        if (e.by === ctx.deps.tabId) return
        activity.emit({
          id: uid(),
          ts: Date.now(),
          kind: 'remote',
          isRemote: true,
          text: 'Another tab archived a card',
        })
      },
      'user.updated': (raw) => {
        const e = raw as Variant<'user.updated'>
        if (e.by === ctx.deps.tabId) return
        // Propagate the rename through the entities store so every card
        // showing this user updates without a refetch.
        ctx.deps.entities.upsert(UserEntity, e.user)
      },
    })

    return {
      board,
      activeBoardId,
      selection: sel,
      moveCard,
      reorderColumn,
      createCard,
      createColumn,
      archiveCard,
      bulkMove,
      // search + filters
      searchInputRaw,
      searchHits,
      isSearching,
      applyFilter,
      selectedPriorities,
      selectedLabelIds,
      selectedAssigneeIds,
      togglePriority,
      toggleLabel,
      toggleAssignee,
      clearFilters,
      filterMatches,
      // selection / detail
      selectedCardId,
      openCard,
      closeCard,
      // drag
      dragPos,
      dragPosRaw,
    }
  },
  { name: 'board' },
)

// ───────── Pure helpers ─────────

export function applyMove(b: Board, vars: MoveVars): Board {
  return {
    ...b,
    cards: {
      ...b.cards,
      [vars.cardId]: { ...(b.cards[vars.cardId] as Card), columnId: vars.toColumnId },
    },
    columns: b.columns.map((col) => {
      if (col.id === vars.fromColumnId && col.id !== vars.toColumnId) {
        return { ...col, cardIds: col.cardIds.filter((id) => id !== vars.cardId) }
      }
      if (col.id === vars.toColumnId) {
        const dedup =
          col.id === vars.fromColumnId
            ? col.cardIds.filter((id) => id !== vars.cardId)
            : col.cardIds
        return {
          ...col,
          cardIds: [...dedup.slice(0, vars.toIndex), vars.cardId, ...dedup.slice(vars.toIndex)],
        }
      }
      return col
    }),
  }
}

export function removeCard(b: Board, cardId: string): Board {
  const next: Board = {
    ...b,
    cards: Object.fromEntries(Object.entries(b.cards).filter(([k]) => k !== cardId)),
    columns: b.columns.map((c) =>
      c.cardIds.includes(cardId) ? { ...c, cardIds: c.cardIds.filter((id) => id !== cardId) } : c,
    ),
  }
  return next
}

function makeActivity(kind: ActivityEvent['kind'], text: string): ActivityEvent {
  return { id: uid(), ts: Date.now(), kind, text }
}

/** Pick a column hue from a small rotating palette so new columns look intentional. */
const COLUMN_HUES = [220, 60, 295, 155, 18, 215, 320, 90]
function randomColumnHue(): number {
  return COLUMN_HUES[Math.floor(Math.random() * COLUMN_HUES.length)] ?? 270
}
