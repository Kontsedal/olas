// Board view — three columns + the cards in each.
//
// Drag-and-drop is wired with `@dnd-kit`. The kanban's three mutations are
// the actual semantics of every drop:
//   - same-column drop  → `reorderColumn` (serial concurrency)
//   - cross-column drop → `moveCard`     (parallel + optimistic + rollback)
//
// Rejected promises are intentionally swallowed at the call site — the
// snapshot returned from `onMutate` auto-rolls back on error, and
// `<ErrorToast />` surfaces the failure with a retry.
//
// Arrow buttons + → moves remain as an a11y fallback.

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { use, useQuery } from '@kontsedal/olas-react'
import { X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { Board as BoardT, Card } from '../api'
import { Column } from './Column'
import { useApi } from './useApi'

const noop = (): void => {}

export function Board(props: {
  onEditCard: (card: Card) => void
  onAddCard: (columnId: string) => void
}): ReactElement {
  const api = useApi()
  const board = useQuery(api.board.board)

  // Each draggable card carries `card:<id>` as its id; each droppable column
  // body carries `col:<id>`. The DragEnd handler decodes both and dispatches.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = (e: DragEndEvent): void => {
    if (!board.data) return
    const overId = e.over?.id
    if (overId == null) return
    const activeId = String(e.active.id)
    if (!activeId.startsWith('card:')) return
    const cardId = activeId.slice(5)

    const targetColumnId = resolveTargetColumn(String(overId), board.data)
    if (targetColumnId === null) return
    const fromColumn = board.data.columns.find((c) => c.cardIds.includes(cardId))
    if (!fromColumn) return

    // Compute drop index — if dropped on another card, place right before it;
    // otherwise (dropped on the column itself) append.
    let toIndex: number
    if (String(overId).startsWith('card:')) {
      const overCardId = String(overId).slice(5)
      const targetCol = board.data.columns.find((c) => c.id === targetColumnId)!
      toIndex = targetCol.cardIds.indexOf(overCardId)
      if (fromColumn.id === targetColumnId) {
        // For same-column reorders, dropping ON a card means "swap with that
        // position" — compute the new sequence and dispatch reorderColumn.
        const filtered = fromColumn.cardIds.filter((id) => id !== cardId)
        const insertAt = Math.max(0, filtered.indexOf(overCardId))
        const next = [...filtered.slice(0, insertAt), cardId, ...filtered.slice(insertAt)]
        api.board.reorderColumn.run({ columnId: targetColumnId, cardIds: next }).catch(noop)
        return
      }
    } else {
      // Dropped on the empty area of a column → append.
      const targetCol = board.data.columns.find((c) => c.id === targetColumnId)!
      toIndex = targetCol.cardIds.length
    }

    if (fromColumn.id === targetColumnId) {
      // Same-column drop on the column body — no-op (already in place).
      return
    }

    api.board.moveCard
      .run({ cardId, fromColumnId: fromColumn.id, toColumnId: targetColumnId, toIndex })
      .catch(noop)
  }

  if (board.isLoading) {
    return (
      <div className="rounded-xl border border-(--color-border) bg-(--color-bg-elev) p-6 text-sm text-(--color-fg-mute)">
        Loading board…
      </div>
    )
  }
  if (board.error !== undefined) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-(--color-danger) bg-(--color-bg-elev) p-4 text-sm text-(--color-danger)"
      >
        Failed: {String(board.error)}
      </div>
    )
  }
  if (board.data === undefined)
    return <div className="text-sm text-(--color-fg-mute)">No board</div>

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <BulkActionBar />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {board.data.columns.map((col) => {
          const cards = col.cardIds
            .map((id) => board.data!.cards[id])
            .filter((c): c is Card => c !== undefined)
          return (
            <Column
              key={col.id}
              column={col}
              cards={cards}
              otherColumns={board.data!.columns.filter((c) => c.id !== col.id)}
              onMove={(cardId, toColumnId, toIndex) =>
                api.board.moveCard
                  .run({ cardId, fromColumnId: col.id, toColumnId, toIndex })
                  .catch(noop)
              }
              onReorder={(cardIds) =>
                api.board.reorderColumn.run({ columnId: col.id, cardIds }).catch(noop)
              }
              onEditCard={props.onEditCard}
              onAddCard={() => props.onAddCard(col.id)}
            />
          )
        })}
      </div>
    </DndContext>
  )
}

/**
 * Bulk-action toolbar — only visible when at least one card is selected.
 * Drives `boardController.bulkMoveSelected`, which loops over each selected
 * id through the existing `moveCard` mutation (parallel + per-card
 * optimistic rollback). Demonstrates the SPEC §17.5 `selection` composable.
 */
function BulkActionBar(): ReactElement | null {
  const api = useApi()
  const sel = api.board.selection
  const size = use(sel.size)
  const board = useQuery(api.board.board)
  if (size === 0 || !board.data) return null
  const columns = board.data.columns
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-(--color-accent) bg-(--color-accent)/10 px-3 py-2 text-sm">
      <span className="font-medium text-(--color-fg)">
        {size} selected
        <span className="ml-2 text-xs font-normal text-(--color-fg-mute)">
          shift-click for ranges · ⌘/Ctrl-click to toggle
        </span>
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {columns.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => void api.board.bulkMoveSelected(c.id)}
            className="rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs font-medium text-(--color-fg) hover:border-(--color-accent) hover:text-(--color-accent)"
          >
            Move → {c.title}
          </button>
        ))}
        <button
          type="button"
          onClick={() => sel.clear()}
          aria-label="Clear selection"
          title="Clear selection"
          className="inline-flex items-center gap-1 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-(--color-fg-mute) hover:text-(--color-fg)"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  )
}

/** Resolve `over.id` (a card or column dnd id) to the target column id. */
function resolveTargetColumn(overId: string, board: BoardT): string | null {
  if (overId.startsWith('col:')) return overId.slice(4)
  if (overId.startsWith('card:')) {
    const cardId = overId.slice(5)
    const col = board.columns.find((c) => c.cardIds.includes(cardId))
    return col?.id ?? null
  }
  return null
}
