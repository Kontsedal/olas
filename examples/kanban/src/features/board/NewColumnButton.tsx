/**
 * Inline "new column" affordance — Linear-style. Click to expand into a
 * compact text input; Enter creates and resets, Escape cancels, blur
 * cancels-if-empty.
 */

import { useRoot } from '@kontsedal/olas-react'
import { Plus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AppApi } from '../../app.controller'

export function NewColumnButton() {
  const app = useRoot<AppApi>()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const reset = (): void => {
    setTitle('')
    setEditing(false)
  }

  const submit = async (): Promise<void> => {
    const t = title.trim()
    if (t === '') {
      reset()
      return
    }
    await app.board.createColumn.run({ title: t })
    reset()
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="olas-column-add"
        aria-label="Add column"
        onClick={() => setEditing(true)}
      >
        <Plus size={14} />
        <span>New column</span>
      </button>
    )
  }

  return (
    <div className="olas-column-add olas-column-add-editing">
      <input
        ref={inputRef}
        className="olas-column-add-input"
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          else if (e.key === 'Escape') reset()
        }}
        onBlur={() => {
          if (title.trim() === '') reset()
        }}
        placeholder="Column name"
        aria-label="New column name"
      />
    </div>
  )
}
