/**
 * Right-hand detail panel. Renders nothing when no card is selected — the
 * grid column collapses to 0 and the board fills the space.
 *
 * The KeepAlive wrapper is wired so the controller's pause/resume signal
 * flips when the panel unmounts — visible in devtools.
 */

import { KeepAlive, use, useField, useQuery, useRoot } from '@kontsedal/olas-react'
import { Archive, Loader2, MoveRight, X } from 'lucide-react'
import type { AppApi } from '../../app.controller'
import { Button, IconButton, Select, Textarea } from '../../ui'
import { CommentsThread } from '../comments/CommentsThread'
import { AssigneesRow } from './AssigneesRow'
import { LabelsRow } from './LabelsRow'
import { SubtasksRow } from './SubtasksRow'

export function CardDetail() {
  const app = useRoot<AppApi>()
  const card = use(app.cardDetail.card)
  if (card === null) return null
  return (
    <KeepAlive controller={app.cardDetail}>
      <DetailPanel />
    </KeepAlive>
  )
}

function DetailPanel() {
  const app = useRoot<AppApi>()
  const card = use(app.cardDetail.card)
  const board = useQuery(app.board.board)
  if (card === null) return null
  const titleField = useField(app.cardDetail.form.fields.title)
  const descField = useField(app.cardDetail.form.fields.description)
  const priorityField = useField(app.cardDetail.form.fields.priority)
  const dueField = useField(app.cardDetail.form.fields.dueDate)
  const titleAsync = use(app.cardDetail.titleAsyncError)
  const isChecking = use(app.cardDetail.isTitleChecking)
  const isSaving = use(app.cardDetail.save.isPending)

  const titleError = titleField.touched ? (titleAsync ?? titleField.errors[0]) : undefined
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
    <aside className="olas-detail">
      <header className="olas-detail-head">
        <div className="olas-detail-id-row">
          <span className="olas-detail-id">{card.id}</span>
          <span className="olas-detail-head-spacer" />
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
          {isChecking && (
            <span className="olas-detail-spinner" role="status" aria-label="Checking title">
              <Loader2 size={14} />
            </span>
          )}
        </div>
        {titleError !== undefined && <div className="olas-field-error">{titleError}</div>}
      </header>

      <div className="olas-detail-body">
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
          disabled={isSaving || !!titleAsync}
          leading={isSaving ? <Loader2 size={14} className="olas-spin" /> : <MoveRight size={14} />}
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </Button>
      </footer>
    </aside>
  )
}
