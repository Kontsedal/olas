// Modal shell + form layout for the card editor.
//
// Both edit-existing and create-new modes use this same modal — the only
// difference is the `target` we open the editor with. The editor controller
// branches on `mode` internally to choose `api.saveCard` vs `api.createCard`.

import { use } from '@kontsedal/olas-react'
import { X } from 'lucide-react'
import { type ReactElement, useEffect, useMemo } from 'react'
import type { CardEditorTarget } from '../controllers/cardEditor'
import { DateRow, PriorityRow, TextareaRow, TextRow } from './form/inputs'
import { SubtasksRow } from './form/SubtasksRow'
import { useApi } from './useApi'

export function CardEditor({
  target,
  onClose,
}: {
  target: CardEditorTarget
  onClose: () => void
}): ReactElement {
  const api = useApi()

  // Construct the child controller once per open. `target` is referentially
  // stable for the lifetime of the modal because the parent passes it via a
  // single state cell (see View/App.tsx).
  const handle = useMemo(() => api.board.openEditor(target), [api, target])
  // Tear down the child when the modal unmounts. Without this, repeated
  // opens leak a `cardEditor[N]` per open into the controller tree until
  // the root disposes.
  useEffect(() => () => handle.dispose(), [handle])
  const editor = handle.api

  const isPending = use(editor.save.isPending)
  const error = use(editor.save.error)
  const flatErrors = use(editor.form.flatErrors)
  const topLevelErrors = use(editor.form.topLevelErrors)
  const savedData = use(editor.save.data)

  // Close on first successful save.
  useEffect(() => {
    if (savedData !== undefined) onClose()
  }, [savedData, onClose])

  const f = editor.form.fields

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          editor.save.run().catch(() => {})
        }}
        className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-(--color-border) bg-(--color-bg-elev) p-5 shadow-[var(--shadow-pop)] max-h-[86vh] overflow-auto"
      >
        <header className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {editor.mode === 'edit' ? 'Edit card' : 'New card'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-(--color-fg-mute) hover:bg-(--color-bg-sunk) hover:text-(--color-fg)"
          >
            <X className="size-4" />
          </button>
        </header>

        <TextRow label="Title" field={f.title} />
        <TextareaRow label="Description" field={f.description} />
        <div className="grid grid-cols-2 gap-3">
          <PriorityRow field={f.priority} />
          <DateRow label="Due date" field={f.dueDate} />
        </div>
        <SubtasksRow array={f.subtasks} />

        {topLevelErrors.length > 0 && (
          <ul role="alert" className="m-0 list-disc pl-5 text-xs text-(--color-danger)">
            {topLevelErrors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        )}
        {flatErrors.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-(--color-fg-mute)">
              {flatErrors.length} field error{flatErrors.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-1 pl-5 list-disc text-(--color-danger)">
              {flatErrors.map((e) => (
                <li key={e.path}>
                  <code className="font-mono">{e.path}</code>: {e.errors.join(', ')}
                </li>
              ))}
            </ul>
          </details>
        )}
        {error !== undefined && (
          <div
            role="alert"
            className="rounded-md bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)"
          >
            {String((error as Error)?.message ?? error)}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-(--color-border) pt-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-(--color-border) bg-(--color-bg-elev) px-3 py-1.5 text-sm hover:bg-(--color-bg-sunk)"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="rounded-lg bg-(--color-accent) px-3 py-1.5 text-sm font-medium text-(--color-accent-fg) hover:brightness-110 disabled:opacity-50"
          >
            {isPending ? (editor.mode === 'edit' ? 'Saving…' : 'Creating…') : 'Save'}
          </button>
        </div>
      </form>
    </div>
  )
}
