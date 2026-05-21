/**
 * Board view — the kanban grid with drag-drop.
 *
 * Drag-drop uses @dnd-kit. We use a vertical SortableContext per column for
 * within-column reordering AND a top-level DndContext for cross-column moves.
 * On `onDragEnd`, we resolve the source/target columns and run either the
 * `reorderColumn` mutation (same column) or the `moveCard` mutation
 * (cross-column).
 */

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { use, useQuery, useRoot } from '@kontsedal/olas-react'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { AppApi } from '../../app.controller'
import { Button, Card, Skeleton } from '../../ui'
import { FilterChips } from '../filters/FilterChips'
import { SearchBar } from '../search/SearchBar'
import { CardTile } from './CardTile'
import { Column } from './Column'
import { NewColumnButton } from './NewColumnButton'

export function Board() {
  const app = useRoot<AppApi>()
  const board = app.board.board
  const boardQuery = useQuery(board)

  // Selection bar
  const selectedIds = use(app.board.selection.selectedIds)
  const selCount = selectedIds.size

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const [activeCardId, setActiveCardId] = useState<string | null>(null)

  const onDragStart = (e: DragStartEvent) => {
    const id = e.active.id as string
    setActiveCardId(id)
    app.board.dragPosRaw.set({ cardId: id, clientX: 0, clientY: 0 })
  }
  const onDragEnd = (e: DragEndEvent) => {
    setActiveCardId(null)
    app.board.dragPosRaw.set(null)
    const { active, over } = e
    if (!over) return
    const cardId = active.id as string
    const overId = over.id as string
    const current = boardQuery.data
    if (!current) return

    // overId is either a column id or a card id; resolve to a target column
    const fromColumn = current.columns.find((c) => c.cardIds.includes(cardId))
    if (!fromColumn) return
    const overIsColumn = current.columns.some((c) => c.id === overId)
    const toColumn = overIsColumn
      ? current.columns.find((c) => c.id === overId)!
      : current.columns.find((c) => c.cardIds.includes(overId))
    if (!toColumn) return

    if (fromColumn.id === toColumn.id) {
      // Same column — reorder.
      const oldIndex = fromColumn.cardIds.indexOf(cardId)
      const newIndex = overIsColumn
        ? fromColumn.cardIds.length - 1
        : fromColumn.cardIds.indexOf(overId)
      if (oldIndex === newIndex) return
      const next = arrayMove(fromColumn.cardIds, oldIndex, newIndex)
      void app.board.reorderColumn.run({ columnId: fromColumn.id, cardIds: next })
    } else {
      // Cross-column.
      const toIndex = overIsColumn ? toColumn.cardIds.length : toColumn.cardIds.indexOf(overId)
      void app.board.moveCard.run({
        cardId,
        fromColumnId: fromColumn.id,
        toColumnId: toColumn.id,
        toIndex: Math.max(0, toIndex),
      })
    }
  }

  return (
    <section className="olas-board-area">
      <header className="olas-board-head">
        <div className="olas-board-head-row">
          <SearchBar />
          <FilterChips />
          <div className="olas-board-head-spacer" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => board.refetch()}
            leading={<RefreshCw size={14} />}
          >
            Refresh
          </Button>
        </div>
      </header>

      {selCount > 0 && (
        <div className="olas-bulk-bar">
          <span>{selCount} selected</span>
          <span className="olas-board-head-spacer" />
          {boardQuery.data?.columns.map((col) => (
            <Button
              key={col.id}
              size="sm"
              variant="ghost"
              onClick={() => void app.board.bulkMove(col.id)}
            >
              → {col.title}
            </Button>
          )) ?? null}
          <Button size="sm" variant="ghost" onClick={() => app.board.selection.clear()}>
            Clear
          </Button>
        </div>
      )}

      {boardQuery.isLoading && boardQuery.data === undefined ? (
        <div className="olas-board-skeleton">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i} variant="flat" className="olas-column">
              <Skeleton height={18} width="50%" />
              <Skeleton height={120} />
              <Skeleton height={120} />
            </Card>
          ))}
        </div>
      ) : boardQuery.error ? (
        <div className="olas-board-error">
          <p>Couldn't load board.</p>
          <Button variant="primary" onClick={() => board.refetch()}>
            Try again
          </Button>
        </div>
      ) : boardQuery.data ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <div className="olas-board">
            {boardQuery.data.columns.map((col) => (
              <SortableContext
                key={col.id}
                items={col.cardIds}
                strategy={verticalListSortingStrategy}
              >
                <Column column={col} board={boardQuery.data!} draggingCardId={activeCardId} />
              </SortableContext>
            ))}
            <NewColumnButton />
          </div>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }}>
            {activeCardId && boardQuery.data.cards[activeCardId] ? (
              <div className="olas-card-tile-overlay">
                <CardTile card={boardQuery.data.cards[activeCardId]!} ordered={[]} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : null}
    </section>
  )
}
