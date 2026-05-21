/**
 * Lightweight "new card" dialog. Title-only; the rest is filled in via the
 * detail panel after creation (we open the new card automatically). Mirrors
 * Linear's "type a title, hit enter, refine later" flow.
 */

import { use, useRoot } from '@kontsedal/olas-react'
import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../../app.controller'
import { Button, Dialog } from '../../ui'

export function CreateCardDialog({
  open,
  columnId,
  columnTitle,
  onClose,
}: {
  open: boolean
  columnId: string
  columnTitle: string
  onClose: () => void
}) {
  const app = useRoot<AppApi>()
  const [title, setTitle] = useState('')
  const isPending = use(app.board.createCard.isPending)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setTitle('')
    queueMicrotask(() => ref.current?.focus())
  }, [open])

  const submit = async () => {
    const t = title.trim()
    if (t === '' || isPending) return
    await app.board.createCard.run({ columnId, title: t })
    onClose()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`New card in ${columnTitle}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={isPending || title.trim() === ''}>
            {isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <label htmlFor="olas-create-card-title" className="olas-field-label">
        Title
      </label>
      <input
        id="olas-create-card-title"
        ref={ref}
        className="olas-input"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
        }}
        placeholder="What needs doing?"
      />
    </Dialog>
  )
}
