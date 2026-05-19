// Board controller — owns the per-board data + writes.
//
// Coverage map (see .wiki/modules/examples.md):
//  - `ctx.use(boardQuery, key)`                          → live board cache
//  - `ctx.mutation({ concurrency: 'parallel' })`         → moveCard
//  - `ctx.mutation({ concurrency: 'latest-wins' })`      → applyFilter
//  - `ctx.mutation({ concurrency: 'serial' })`           → reorderColumn
//  - `Snapshot.rollback` (in onError)                    → optimistic recovery
//  - `defineScope` + `ctx.provide`                       → currentBoardScope,
//                                                          activityScope
//  - `ctx.emitter` + `ctx.on`                            → activity feed

import { type Ctx, defineController, signal } from '@olas/core'
import type { Board, SearchResults } from '../api'
import { boardQuery } from '../query'
import { type ActivityEvent, activityScope, currentBoardScope } from '../scopes'
import { type CardEditorTarget, cardEditorController } from './cardEditor'

export type BoardProps = { boardId: string }

export type MoveVars = {
  cardId: string
  fromColumnId: string
  toColumnId: string
  toIndex: number
}

const ACTIVITY_CAP = 20

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const boardController = defineController(
  (ctx: Ctx, props: BoardProps) => {
    ctx.provide(currentBoardScope, { id: props.boardId })

    // Activity bus — bounded ring buffer of recent events for the UI panel.
    // Provided to descendants (cardEditor) via scope so they can emit too.
    const activity = ctx.emitter<ActivityEvent>()
    ctx.provide(activityScope, activity)
    const recentActivity = signal<ActivityEvent[]>([])
    ctx.on(activity, (ev) => {
      recentActivity.update((arr) => [ev, ...arr].slice(0, ACTIVITY_CAP))
    })

    const board = ctx.use(boardQuery, () => [props.boardId])

    // ----- Mutation 1: moveCard, parallel + optimistic + manual rollback -----
    //
    // Two independent card moves can race; both apply their snapshots
    // synchronously. On error we call `snapshot.rollback()` ourselves —
    // Olas only auto-rolls back when a run is *aborted* (latest-wins
    // supersede / dispose). Spec §6.3, §6.4.
    const moveCard = ctx.mutation<MoveVars, void>({
      name: 'moveCard',
      concurrency: 'parallel',
      onMutate: (vars) =>
        boardQuery.setData(props.boardId, (prev) => {
          if (!prev) throw new Error('moveCard before board loaded')
          return applyMove(prev, vars)
        }),
      mutate: (vars, signal) =>
        ctx.deps.api.moveCard(
          props.boardId,
          vars.cardId,
          vars.fromColumnId,
          vars.toColumnId,
          vars.toIndex,
          signal,
        ),
      onSuccess: (_r, vars) => {
        activity.emit({
          ts: Date.now(),
          kind: 'move',
          text: `Moved ${vars.cardId} → ${vars.toColumnId}`,
        })
      },
      // No explicit rollback — the snapshot returned from `onMutate`
      // auto-rolls back on non-abort errors. Spec §6.4.
      onError: (err, vars) => {
        activity.emit({
          ts: Date.now(),
          kind: 'error',
          text: `Move ${vars.cardId} → ${vars.toColumnId} failed: ${errorMessage(err)}`,
        })
      },
    })

    // ----- Mutation 2: applyFilter, latest-wins -----
    //
    // Rapid invocations (the user keeps typing) supersede prior in-flight
    // calls. The aborted run rejects with AbortError — call sites swallow
    // those rejections since they're expected. Spec §6.3.
    const filterResults = signal<SearchResults | null>(null)
    const applyFilter = ctx.mutation<{ q: string }, SearchResults>({
      name: 'applyFilter',
      concurrency: 'latest-wins',
      mutate: async (vars, signal) => {
        const r = await ctx.deps.api.search(props.boardId, vars.q, signal)
        if (signal.aborted) throw new DOMException('Superseded', 'AbortError')
        return r
      },
      onSuccess: (result) => {
        filterResults.set(result)
      },
    })

    // ----- Mutation 3: reorderColumn, serial -----
    //
    // Multiple rapid reorders on the same column shouldn't interleave at the
    // api. Serial queues runs and applies them in submission order. Spec §6.3.
    const reorderColumn = ctx.mutation<{ columnId: string; cardIds: string[] }, void>({
      name: 'reorderColumn',
      concurrency: 'serial',
      onMutate: (vars) =>
        boardQuery.setData(props.boardId, (prev) => {
          if (!prev) throw new Error('reorderColumn before board loaded')
          return {
            ...prev,
            columns: prev.columns.map((c) =>
              c.id === vars.columnId ? { ...c, cardIds: vars.cardIds.slice() } : c,
            ),
          }
        }),
      mutate: (vars, signal) =>
        ctx.deps.api.reorderColumn(props.boardId, vars.columnId, vars.cardIds, signal),
      onSuccess: (_r, vars) => {
        activity.emit({
          ts: Date.now(),
          kind: 'move',
          text: `Reordered column ${vars.columnId}`,
        })
      },
      onError: (err, vars, snapshot) => {
        snapshot?.rollback()
        activity.emit({
          ts: Date.now(),
          kind: 'error',
          text: `Reorder ${vars.columnId} failed: ${errorMessage(err)}`,
        })
      },
    })

    return {
      board,
      moveCard,
      applyFilter,
      filterResults,
      reorderColumn,
      recentActivity,
      boardId: props.boardId,
      /**
       * Open a card editor. Returns `{ api, dispose }` (via `ctx.attach`) so
       * closing the modal can tear the editor down explicitly — without the
       * caller, every open would leak a controller until the parent disposes.
       * Must live here (not on the root) so the child sees
       * `currentBoardScope` + `activityScope`. Spec §10.3.
       */
      openEditor: (target: CardEditorTarget) => ctx.attach(cardEditorController, { target }),
    }
  },
  { name: 'board' },
)

// --- Pure helpers --------------------------------------------------------

export function applyMove(board: Board, vars: MoveVars): Board {
  return {
    ...board,
    columns: board.columns.map((col) => {
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
