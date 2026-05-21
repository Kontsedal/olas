/**
 * One card in a column. Sortable (via `useSortable`), opens the detail pane
 * on click, supports multi-select via shift / meta-click. Renders:
 *  - Priority pip
 *  - Title
 *  - Labels (read via the entities plugin — a label rename anywhere bubbles
 *    here without a refetch)
 *  - AvatarStack of assignees (same entity story)
 *  - Subtask progress + comment count
 *  - Due-date relative timestamp
 */

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { use, useRoot } from '@kontsedal/olas-react'
import { CalendarDays, GripVertical, MessageSquare } from 'lucide-react'
import type { CSSProperties, MouseEvent } from 'react'
import type { Card as CardData, Priority } from '../../api'
import type { AppApi } from '../../app.controller'
import { LabelEntity, UserEntity } from '../../entities'
import { AvatarStack, cx, Tag } from '../../ui'

const PRIORITY_TONE: Record<Priority, 'info' | 'neutral' | 'warning' | 'danger'> = {
  low: 'info',
  med: 'neutral',
  high: 'warning',
  urgent: 'danger',
}

const PRIORITY_LABEL: Record<Priority, string> = {
  low: 'Low',
  med: 'Medium',
  high: 'High',
  urgent: 'Urgent',
}

export function CardTile({ card, ordered }: { card: CardData; ordered: readonly string[] }) {
  const app = useRoot<AppApi>()
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  })
  const selectedIds = use(app.board.selection.selectedIds)
  const selectedCardId = use(app.board.selectedCardId)
  const isSelected = selectedIds.has(card.id)
  const isOpen = selectedCardId === card.id

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  }

  const labels = card.labelIds
    .map((id) => app.entities.get(LabelEntity, id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined)

  const assignees = card.assigneeIds
    .map((id) => app.entities.get(UserEntity, id))
    .filter((u): u is NonNullable<typeof u> => u !== undefined)

  const doneSubs = card.subtasks.filter((s) => s.done).length
  const totalSubs = card.subtasks.length

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      app.board.selection.handleClick(
        card.id,
        { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey },
        ordered,
      )
      return
    }
    app.board.openCard(card.id)
  }

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={cx(
        'olas-card-tile',
        isSelected && 'olas-card-tile-selected',
        isOpen && 'olas-card-tile-open',
      )}
      onClick={onClick}
      data-card-id={card.id}
    >
      <span
        {...attributes}
        {...listeners}
        className="olas-card-grip"
        role="button"
        tabIndex={0}
        aria-label="Drag handle"
      >
        <GripVertical size={14} />
      </span>

      <div className="olas-card-tile-main">
        {card.priority !== 'med' && (
          <Tag tone={PRIORITY_TONE[card.priority]} dot>
            {PRIORITY_LABEL[card.priority]}
          </Tag>
        )}
        <h4 className="olas-card-tile-title">{card.title}</h4>

        {labels.length > 0 && (
          <div className="olas-card-tile-labels">
            {labels.map((l) => (
              <Tag key={l.id} hue={l.hue}>
                {l.name}
              </Tag>
            ))}
          </div>
        )}

        <footer className="olas-card-tile-foot">
          {totalSubs > 0 && (
            <span className="olas-card-tile-meta" title={`${doneSubs}/${totalSubs} subtasks`}>
              <span className="olas-card-tile-progress" aria-hidden>
                <span style={{ width: `${(doneSubs / totalSubs) * 100}%` }} />
              </span>
              <span>
                {doneSubs}/{totalSubs}
              </span>
            </span>
          )}
          {card.commentsCount > 0 && (
            <span className="olas-card-tile-meta">
              <MessageSquare size={12} /> {card.commentsCount}
            </span>
          )}
          {card.dueDate && (
            <span className="olas-card-tile-meta" title={card.dueDate}>
              <CalendarDays size={12} /> {relTime(card.dueDate)}
            </span>
          )}
          <span className="olas-card-tile-spacer" />
          {assignees.length > 0 && <AvatarStack members={assignees} size="sm" />}
        </footer>
      </div>
    </article>
  )
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return iso
  const diff = t - Date.now()
  const days = Math.round(diff / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days === -1) return 'yesterday'
  if (days > 0) return `in ${days}d`
  return `${-days}d ago`
}
