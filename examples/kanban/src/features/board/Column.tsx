/**
 * A column in the kanban grid. Renders the column header + a vertical stack
 * of card tiles. Filter visibility is applied here — cards that don't match
 * the active filter are rendered as faded ghosts so the layout doesn't jump.
 *
 * The column body is a `useDroppable` target so dragging a card from another
 * column onto an empty area inside the body resolves to this column id.
 */

import { useDroppable } from '@dnd-kit/core'
import { use, useRoot } from '@kontsedal/olas-react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { useState } from 'react'
import type { Board as BoardData, Column as ColumnData } from '../../api'
import type { AppApi } from '../../app.controller'
import { cx, IconButton, Tag } from '../../ui'
import { CardTile } from './CardTile'
import { CreateCardDialog } from './CreateCardDialog'

export function Column({
  column,
  board,
  draggingCardId,
}: {
  column: ColumnData
  board: BoardData
  draggingCardId: string | null
}) {
  const app = useRoot<AppApi>()
  const matches = use(app.board.filterMatches)
  const style = { ['--column-hue' as string]: String(column.hue) } as React.CSSProperties
  const [createOpen, setCreateOpen] = useState(false)

  const visibleCount =
    matches === null ? column.cardIds.length : column.cardIds.filter((id) => matches.has(id)).length

  // Droppable on the column id — cross-column drops resolve here even when
  // the cursor lands on the empty area rather than another card.
  const { setNodeRef, isOver } = useDroppable({ id: column.id })

  return (
    <section className="olas-column" style={style} aria-label={column.title}>
      <header className="olas-column-head">
        <span className="olas-column-pill" aria-hidden />
        <h3 className="olas-column-title">{column.title}</h3>
        <Tag>{visibleCount}</Tag>
        <span className="olas-column-spacer" />
        <IconButton
          size="sm"
          label={`Add card to ${column.title}`}
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={14} />
        </IconButton>
        <IconButton size="sm" label="Column options">
          <MoreHorizontal size={14} />
        </IconButton>
      </header>

      <div
        ref={setNodeRef}
        className={cx('olas-column-body', isOver && 'olas-column-body-over')}
        data-column-id={column.id}
      >
        {column.cardIds.length === 0 ? (
          <div className="olas-column-empty">Drop a card here</div>
        ) : (
          column.cardIds.map((cardId) => {
            const card = board.cards[cardId]
            if (!card) return null
            const isMatch = matches === null || matches.has(cardId)
            return (
              <div
                key={cardId}
                className={cx(
                  'olas-card-slot',
                  !isMatch && 'olas-card-slot-faded',
                  draggingCardId === cardId && 'olas-card-slot-dragging',
                )}
              >
                <CardTile card={card} ordered={column.cardIds} />
              </div>
            )
          })
        )}
      </div>

      <CreateCardDialog
        open={createOpen}
        columnId={column.id}
        columnTitle={column.title}
        onClose={() => setCreateOpen(false)}
      />
    </section>
  )
}
