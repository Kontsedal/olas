// Subtasks field-array — one input + checkbox per item, with add/remove.
//
// `array.items.value` is reactive; `useArray.items.value` re-renders when
// items are added/removed. Individual fields inside each item use `useField`
// for fine-grained subscriptions.

import { use, useField } from '@olas/react'
import type { ReactElement } from 'react'
import { Plus, X } from 'lucide-react'
import type { SubtaskForm } from '../../schema'
import type { FieldArray } from '@olas/core'
import { fieldInputClass } from './inputs'

export function SubtasksRow({
  array,
}: { array: FieldArray<SubtaskForm> }): ReactElement {
  const items = use(array.items)
  return (
    <div className="rounded-md border border-(--color-border) p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-(--color-fg-mute)">
          Subtasks
        </span>
        <button
          type="button"
          onClick={() => array.add({ text: '', done: false })}
          className="inline-flex items-center gap-1 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-[11px] text-(--color-fg-mute) hover:text-(--color-fg)"
        >
          <Plus className="size-3" /> add
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {items.map((item, idx) => (
          <Row key={idx} item={item} onRemove={() => array.remove(idx)} />
        ))}
        {items.length === 0 && (
          <li className="text-[11px] text-(--color-fg-mute)">No subtasks yet.</li>
        )}
      </ul>
    </div>
  )
}

function Row(props: { item: SubtaskForm; onRemove: () => void }): ReactElement {
  const text = useField(props.item.fields.text)
  const done = useField(props.item.fields.done)
  return (
    <li className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={done.value}
        onChange={(e) => done.set(e.target.checked)}
        className="accent-(--color-accent)"
      />
      <input
        className={`${fieldInputClass} flex-1`}
        value={text.value}
        onChange={(e) => text.set(e.target.value)}
        onBlur={text.markTouched}
      />
      <button
        type="button"
        onClick={props.onRemove}
        className="rounded-md p-1 text-(--color-fg-mute) hover:bg-(--color-bg-sunk) hover:text-(--color-danger)"
      >
        <X className="size-3.5" />
      </button>
    </li>
  )
}
