/**
 * Right-hand detail panel. Renders nothing when no card is selected — the
 * grid column collapses to 0 and the board fills the space.
 *
 * The head stays mounted while a card is open. The details below it sit in a
 * `<SuspendOnUnmount>` wrapper, so collapsing them or closing the card
 * suspends the controller instead of disposing it, and expanding resumes it.
 * The head's state tag reads the controller's `isPaused`, which puts the
 * wrapper's effect on screen. A draft typed before a collapse is still in the
 * form after the expand, because the controller and its form never went away.
 *
 * `CardDetail` owns the "is a card selected?" branch, and `DetailPanel` and
 * `DetailBody` take the card as a prop. Neither of those two returns early,
 * because React matches hooks by call order, and a component that returns
 * before its hooks renders a different number of them per pass.
 */

import { SuspendOnUnmount, useField, useQuery, useRoot, useValue } from '@kontsedal/olas-react'
import { Archive, ChevronDown, ChevronUp, Loader2, MoveRight, X } from 'lucide-react'
import { useState } from 'react'
import type { Card } from '../../api'
import { Button, IconButton, Select, Tag, Textarea } from '../../ui'
import { CommentsThread } from '../comments/CommentsThread'
import { AssigneesRow } from './AssigneesRow'
import { LabelsRow } from './LabelsRow'
import { SubtasksRow } from './SubtasksRow'

export function CardDetail() {
  const app = useRoot()
  const card = useValue(app.cardDetail.card)
  if (card === null) return null
  return <DetailPanel card={card} />
}

function DetailPanel({ card }: { card: Card }) {
  const app = useRoot()
  const isPaused = useValue(app.cardDetail.isPaused)
  const [collapsed, setCollapsed] = useState(false)

  return (
    <aside className="olas-detail">
      <header className="olas-detail-head">
        <div className="olas-detail-id-row">
          <span className="olas-detail-id">{card.id}</span>
          <Tag
            tone={isPaused ? 'neutral' : 'success'}
            role="status"
            title="Set by <SuspendOnUnmount>: suspended while the details are unmounted"
            className="olas-detail-state"
          >
            {isPaused ? 'Suspended' : 'Live'}
          </Tag>
          <span className="olas-detail-head-spacer" />
          <IconButton
            label={collapsed ? 'Expand details' : 'Collapse details'}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </IconButton>
          <IconButton
            label="Archive card"
            title="Archive card"
            onClick={() => void app.board.archiveCard.run({ cardId: card.id })}
          >
            <Archive size={14} />
          </IconButton>
          <IconButton label="Close panel" title="Close" onClick={app.cardDetail.close}>
            <X size={14} />
          </IconButton>
        </div>
      </header>

      {collapsed ? (
        <div className="olas-detail-body">
          <p className="olas-detail-collapsed">
            The details are unmounted, so the card controller is suspended rather than disposed. Its
            form still holds your unsaved edits.
          </p>
        </div>
      ) : (
        <SuspendOnUnmount controller={app.cardDetail}>
          <DetailBody card={card} />
        </SuspendOnUnmount>
      )}
    </aside>
  )
}

function DetailBody({ card }: { card: Card }) {
  const app = useRoot()
  const board = useQuery(app.board.board)
  const titleField = useField(app.cardDetail.form.fields.title)
  const descField = useField(app.cardDetail.form.fields.description)
  const priorityField = useField(app.cardDetail.form.fields.priority)
  const dueField = useField(app.cardDetail.form.fields.dueDate)
  const isSaving = useValue(app.cardDetail.save.isPending)

  const titleError = titleField.touched ? titleField.errors[0] : undefined
  const columns = board.data?.columns ?? []

  const moveTo = (toColumnId: string): void => {
    if (toColumnId === card.columnId) return
    void app.board.moveCard.run({
      cardId: card.id,
      fromColumnId: card.columnId,
      toColumnId,
      toIndex: 0,
    })
  }

  return (
    <>
      <div className="olas-detail-body">
        <div>
          <div className="olas-detail-title-row">
            <input
              value={titleField.value}
              onChange={(e) => titleField.set(e.currentTarget.value)}
              onBlur={titleField.markTouched}
              placeholder="Card title"
              aria-label="Title"
              aria-invalid={titleError !== undefined ? 'true' : undefined}
              className="olas-detail-title-input"
            />
            {titleField.isValidating && (
              <span className="olas-detail-spinner" role="status" aria-label="Checking title">
                <Loader2 size={14} />
              </span>
            )}
          </div>
          {titleError !== undefined && <div className="olas-field-error">{titleError}</div>}
        </div>

        <div className="olas-detail-row-grid olas-detail-row-grid-3">
          <Select
            label="Status"
            value={card.columnId}
            onChange={(e) => moveTo(e.currentTarget.value)}
          >
            {columns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </Select>
          <Select
            label="Priority"
            value={priorityField.value}
            onChange={(e) => priorityField.set(e.currentTarget.value as typeof priorityField.value)}
          >
            <option value="low">Low</option>
            <option value="med">Medium</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
          <div>
            <label htmlFor="olas-detail-due" className="olas-field-label">
              Due
            </label>
            <input
              id="olas-detail-due"
              type="date"
              value={dueField.value ?? ''}
              onChange={(e) => dueField.set(e.currentTarget.value)}
              className="olas-input"
            />
          </div>
        </div>

        <Textarea
          label="Description"
          value={descField.value}
          onChange={(e) => descField.set(e.currentTarget.value)}
          onBlur={descField.markTouched}
          placeholder="Add a description…"
          error={descField.touched ? descField.errors[0] : undefined}
        />

        <AssigneesRow />
        <LabelsRow />
        <SubtasksRow />

        <CommentsThread cardId={card.id} />
      </div>

      <footer className="olas-detail-foot">
        <Button variant="ghost" onClick={app.cardDetail.close} disabled={isSaving}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={() => void app.cardDetail.save.run()}
          disabled={isSaving || !titleField.isValid}
          leading={isSaving ? <Loader2 size={14} className="olas-spin" /> : <MoveRight size={14} />}
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </Button>
      </footer>
    </>
  )
}
