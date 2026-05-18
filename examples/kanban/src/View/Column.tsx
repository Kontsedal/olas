// One column. Renders its cards plus reordering/move/add controls.

import type { ReactElement } from 'react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  CheckSquare,
  Plus,
} from 'lucide-react'
import type { Card, Column as ColumnT, Priority } from '../api'

export type ColumnProps = {
  column: ColumnT
  cards: Card[]
  otherColumns: ColumnT[]
  onMove: (cardId: string, toColumnId: string, toIndex: number) => Promise<void>
  onReorder: (cardIds: string[]) => Promise<void>
  onEditCard: (card: Card) => void
  onAddCard: () => void
}

export function Column(props: ColumnProps): ReactElement {
  const { column, cards, otherColumns, onMove, onReorder, onEditCard, onAddCard } = props
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-(--color-border) bg-(--color-bg-elev) p-3 shadow-[var(--shadow-card)] min-w-0">
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-(--color-fg-mute)">
          <span>{column.title}</span>
          <span className="rounded-full bg-(--color-bg-sunk) px-2 py-0.5 text-[11px] font-medium tracking-normal text-(--color-fg-mute) normal-case">
            {cards.length}
          </span>
        </h2>
        <button
          type="button"
          onClick={onAddCard}
          aria-label={`Add card to ${column.title}`}
          className="inline-flex items-center gap-1 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-0.5 text-[11px] text-(--color-fg-mute) hover:border-(--color-accent) hover:text-(--color-accent) transition"
        >
          <Plus className="size-3" /> Add
        </button>
      </header>

      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {cards.map((card, idx) => (
          <CardRow
            key={card.id}
            card={card}
            index={idx}
            column={column}
            otherColumns={otherColumns}
            cardCount={cards.length}
            onEdit={() => onEditCard(card)}
            onReorder={onReorder}
            onMove={onMove}
          />
        ))}
        {cards.length === 0 && (
          <li className="rounded-lg border border-dashed border-(--color-border) p-4 text-center text-xs text-(--color-fg-mute)">
            No cards. Click <em>Add</em> to start.
          </li>
        )}
      </ul>
    </section>
  )
}

function CardRow(props: {
  card: Card
  index: number
  column: ColumnT
  otherColumns: ColumnT[]
  cardCount: number
  onEdit: () => void
  onReorder: (cardIds: string[]) => Promise<void>
  onMove: (cardId: string, toColumnId: string, toIndex: number) => Promise<void>
}): ReactElement {
  const { card, index, column, otherColumns, cardCount, onEdit, onReorder, onMove } = props
  return (
    <li className="group rounded-lg border border-(--color-border) bg-(--color-bg-sunk) p-3 transition hover:-translate-y-px hover:shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-2">
        <button
          type="button"
          className="flex-1 text-left text-sm font-semibold leading-tight text-(--color-fg) hover:text-(--color-accent)"
          onClick={onEdit}
        >
          {card.title}
        </button>
        <PriorityBadge priority={card.priority} />
      </div>

      {(card.subtasks.length > 0 || card.dueDate) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-(--color-fg-mute)">
          {card.subtasks.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <CheckSquare className="size-3" />
              {card.subtasks.filter((s) => s.done).length}/{card.subtasks.length}
            </span>
          )}
          {card.dueDate && <DueDate date={card.dueDate} />}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        <IconButton
          title="Move up"
          disabled={index === 0}
          onClick={() => {
            const next = [...column.cardIds]
            ;[next[index - 1]!, next[index]!] = [next[index]!, next[index - 1]!]
            void onReorder(next)
          }}
        >
          <ArrowUp className="size-3" />
        </IconButton>
        <IconButton
          title="Move down"
          disabled={index === cardCount - 1}
          onClick={() => {
            const next = [...column.cardIds]
            ;[next[index + 1]!, next[index]!] = [next[index]!, next[index + 1]!]
            void onReorder(next)
          }}
        >
          <ArrowDown className="size-3" />
        </IconButton>
        {otherColumns.map((c) => (
          <IconButton
            key={c.id}
            title={`Move to ${c.title}`}
            onClick={() => void onMove(card.id, c.id, 0)}
          >
            <ArrowRight className="size-3" />
            <span className="font-medium">{c.title}</span>
          </IconButton>
        ))}
      </div>
    </li>
  )
}

function IconButton(props: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: ReactElement | (ReactElement | string)[]
}): ReactElement {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="inline-flex items-center gap-1 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-0.5 text-[10.5px] text-(--color-fg-mute) hover:text-(--color-fg) hover:border-(--color-accent) disabled:opacity-30 disabled:cursor-not-allowed transition"
    >
      {props.children}
    </button>
  )
}

function PriorityBadge({ priority }: { priority: Priority }): ReactElement {
  const cls =
    priority === 'high'
      ? 'bg-(--color-danger)/15 text-(--color-danger) ring-1 ring-(--color-danger)/30'
      : priority === 'med'
        ? 'bg-(--color-warning)/15 text-(--color-warning) ring-1 ring-(--color-warning)/30'
        : 'bg-(--color-success)/15 text-(--color-success) ring-1 ring-(--color-success)/30'
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${cls}`}>
      {priority.toUpperCase()}
    </span>
  )
}

function DueDate({ date }: { date: string }): ReactElement {
  const today = new Date().toISOString().slice(0, 10)
  const overdue = date < today
  return (
    <span className={`inline-flex items-center gap-1 ${overdue ? 'text-(--color-danger) font-semibold' : ''}`}>
      <CalendarDays className="size-3" />
      {date}
    </span>
  )
}
