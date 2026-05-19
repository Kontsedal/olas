// One column. Renders its cards plus reordering/move/add controls.
//
// Each card is a `useDraggable` source; the column body is `useDroppable`.
// The actual drop semantics (which mutation fires, whether to reorder vs
// move) live in `<Board>`'s `onDragEnd`. Cards keep their arrow + → buttons
// as an a11y fallback for keyboard / screen reader users.

import { useDraggable, useDroppable } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { use } from '@kontsedal/olas-react'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarDays,
  CheckSquare,
  GripVertical,
  Pencil,
  Plus,
} from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Card, Column as ColumnT, Priority } from '../api'
import { useApi } from './useApi'

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
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.id}` })
  // Ordered card ids in this column — shift-click range select uses this so
  // the range is bounded by the column the user is interacting with.
  const orderedIds = useMemo(() => cards.map((c) => c.id), [cards])

  return (
    <section
      ref={setNodeRef}
      className={`flex flex-col gap-3 rounded-xl border bg-(--color-bg-elev) p-3 shadow-[var(--shadow-card)] min-w-0 transition-colors ${
        isOver ? 'border-(--color-accent) bg-(--color-accent)/5' : 'border-(--color-border)'
      }`}
    >
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

      <ul className="flex flex-col gap-2 list-none p-0 m-0 min-h-[40px]">
        {cards.map((card, idx) => (
          <CardRow
            key={card.id}
            card={card}
            index={idx}
            column={column}
            orderedIds={orderedIds}
            otherColumns={otherColumns}
            cardCount={cards.length}
            onEdit={() => onEditCard(card)}
            onReorder={onReorder}
            onMove={onMove}
          />
        ))}
        {cards.length === 0 && (
          <li className="rounded-lg border border-dashed border-(--color-border) p-4 text-center text-xs text-(--color-fg-mute)">
            Drop a card here, or click <em>Add</em>.
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
  orderedIds: readonly string[]
  otherColumns: ColumnT[]
  cardCount: number
  onEdit: () => void
  onReorder: (cardIds: string[]) => Promise<void>
  onMove: (cardId: string, toColumnId: string, toIndex: number) => Promise<void>
}): ReactElement {
  const { card, index, column, orderedIds, otherColumns, cardCount, onEdit, onReorder, onMove } =
    props
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `card:${card.id}`,
  })
  const [isInlineEditing, setIsInlineEditing] = useState(false)
  const api = useApi()
  const sel = api.board.selection
  const selected = use(sel.isSelected(card.id))

  const onSelectionClick = (e: MouseEvent<HTMLInputElement>): void => {
    sel.handleClick(card.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey }, orderedIds)
  }

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`group rounded-lg border bg-(--color-bg-sunk) p-3 transition hover:-translate-y-px hover:shadow-[var(--shadow-card)] ${
        isDragging ? 'ring-2 ring-(--color-accent)' : ''
      } ${
        selected
          ? 'border-(--color-accent) ring-1 ring-(--color-accent) bg-(--color-accent)/5'
          : 'border-(--color-border)'
      }`}
    >
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-label="Drag handle"
          className="cursor-grab text-(--color-fg-mute) hover:text-(--color-fg) -ml-1"
          {...listeners}
          {...attributes}
        >
          <GripVertical className="size-4" />
        </button>
        <input
          type="checkbox"
          aria-label={`Select ${card.title} (shift-click for range, ⌘/ctrl-click to toggle)`}
          checked={selected}
          onChange={() => {}}
          onClick={onSelectionClick}
          title="Shift-click for range · ⌘/Ctrl-click to toggle"
          className={`size-3.5 accent-(--color-accent) transition-opacity ${
            selected ? 'opacity-100' : 'opacity-30 group-hover:opacity-100'
          }`}
        />
        {isInlineEditing ? (
          <InlineTitleEditor card={card} onDone={() => setIsInlineEditing(false)} />
        ) : (
          <>
            <button
              type="button"
              className="flex-1 text-left text-sm font-semibold leading-tight text-(--color-fg) hover:text-(--color-accent)"
              onClick={onEdit}
              onDoubleClick={(e) => {
                e.preventDefault()
                setIsInlineEditing(true)
              }}
              title="Click to open editor · double-click to rename inline"
            >
              {card.title}
            </button>
            <button
              type="button"
              aria-label="Rename inline"
              className="rounded p-0.5 text-(--color-fg-mute) opacity-0 transition group-hover:opacity-100 hover:text-(--color-accent)"
              onClick={() => setIsInlineEditing(true)}
              title="Rename (inline) — demonstrates ctx.attach ephemeral controller"
            >
              <Pencil className="size-3" />
            </button>
          </>
        )}
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
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold ${cls}`}
    >
      {priority.toUpperCase()}
    </span>
  )
}

/**
 * Inline title editor. Spawns an ephemeral controller via
 * `boardController.openInlineTitleEditor(card)` (which calls `ctx.attach`),
 * holds the `{ api, dispose }` handle, and disposes on save / cancel / blur.
 * Exists to demonstrate the SPEC §11.1 "ephemeral child controller" pattern.
 */
function InlineTitleEditor({ card, onDone }: { card: Card; onDone: () => void }): ReactElement {
  const api = useApi()
  const handle = useMemo(() => api.board.openInlineTitleEditor(card), [api, card])
  useEffect(() => () => handle.dispose(), [handle])
  const editor = handle.api
  const draftValue = use(editor.draft)
  const isPending = use(editor.commit.isPending)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const finish = (commit: boolean): void => {
    if (!commit) {
      onDone()
      return
    }
    editor.commit
      .run()
      .catch(() => {
        // surface errors via the Activity feed; just close the editor.
      })
      .finally(() => onDone())
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(false)
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      value={draftValue}
      onChange={(e) => editor.draft.set(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      disabled={isPending}
      aria-label="Rename card inline"
      className="flex-1 rounded border border-(--color-accent) bg-(--color-bg-elev) px-1.5 py-0.5 text-sm font-semibold leading-tight text-(--color-fg) outline-none ring-2 ring-(--color-accent)/30 disabled:opacity-60"
    />
  )
}

function DueDate({ date }: { date: string }): ReactElement {
  const today = new Date().toISOString().slice(0, 10)
  const overdue = date < today
  return (
    <span
      className={`inline-flex items-center gap-1 ${overdue ? 'text-(--color-danger) font-semibold' : ''}`}
    >
      <CalendarDays className="size-3" />
      {date}
    </span>
  )
}
