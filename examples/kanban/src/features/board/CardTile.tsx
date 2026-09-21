/**
 * One card in a column. Sortable (via `useSortable`), opens the detail pane
 * on click, supports multi-select via shift / meta-click. Renders:
 *  - Priority pip
 *  - Title
 *  - Labels (read via the entities plugin — a label rename anywhere bubbles
 *    here without a refetch)
 *  - Assignee avatars (same entity story)
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
import { Avatar, cx, Tag } from '../../ui'

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

        {card.labelIds.length > 0 && (
          <div className="olas-card-tile-labels">
            {card.labelIds.map((id) => (
              <LabelTag key={id} id={id} />
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
          {card.assigneeIds.length > 0 && <AssigneeAvatars ids={card.assigneeIds} />}
        </footer>
      </div>
    </article>
  )
}

/**
 * One label, read reactively.
 *
 * `entities.get(...)` is a documented non-reactive peek, so a rename made
 * anywhere else in the app would not reach this tile until the board query
 * refetched — which is the opposite of what this example is here to show.
 * `entities.signal(...)` is the reactive read, and `use(...)` subscribes to
 * it. One component per id, rather than a `use(...)` inside the `.map`,
 * because React matches hooks by call order and the id list changes length.
 */
function LabelTag({ id }: { id: string }) {
  const app = useRoot<AppApi>()
  const label = use(app.entities.signal(LabelEntity, id))
  if (label === undefined) return null
  return <Tag hue={label.hue}>{label.name}</Tag>
}

/**
 * The assignee stack. It mirrors the `AvatarStack` primitive's overflow
 * maths rather than calling it, because each avatar has to do its own
 * reactive `entities.signal` read — `AvatarStack` takes resolved members,
 * and resolving them in the parent would need one hook per id.
 */
function AssigneeAvatars({ ids, max = 3 }: { ids: readonly string[]; max?: number }) {
  const shown = ids.slice(0, max)
  const overflow = ids.length - shown.length
  return (
    <span className="olas-avatar-stack">
      {shown.map((id) => (
        <AssigneeAvatar key={id} id={id} />
      ))}
      {overflow > 0 && <Avatar name={`+${overflow}`} size="sm" />}
    </span>
  )
}

function AssigneeAvatar({ id }: { id: string }) {
  const app = useRoot<AppApi>()
  const user = use(app.entities.signal(UserEntity, id))
  if (user === undefined) return null
  return <Avatar name={user.name} hue={user.hue} size="sm" />
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
