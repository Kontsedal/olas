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
import { useQuery } from '@olas/react'
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
