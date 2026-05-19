// Generic form-field wrappers. Each takes a `Field<T>` and renders a labeled
// row with the appropriate input. `useField` batches the field's six signals
// into a single re-render — see @kontsedal/olas-react § useField.

import type { Field } from '@kontsedal/olas-core'
import { useField } from '@kontsedal/olas-react'
import type { ReactElement } from 'react'
import type { Priority } from '../../api'

const fieldInputClass =
  'rounded-md border border-(--color-border) bg-(--color-bg-sunk) px-2.5 py-1.5 text-sm text-(--color-fg) outline-none focus:border-(--color-accent) focus:ring-2 focus:ring-(--color-accent)/30'

function Label({ children }: { children: string }): ReactElement {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-(--color-fg-mute)">
      {children}
    </span>
  )
}

function FieldError({ message }: { message: string }): ReactElement {
  return <span className="text-xs text-(--color-danger)">{message}</span>
}

export function TextRow({ label, field }: { label: string; field: Field<string> }): ReactElement {
  const f = useField(field)
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        className={fieldInputClass}
        value={f.value}
        onChange={(e) => f.set(e.target.value)}
        onBlur={f.markTouched}
        aria-invalid={f.errors.length > 0 ? true : undefined}
      />
      {f.touched && f.errors[0] !== undefined && <FieldError message={f.errors[0]} />}
    </label>
  )
}

export function TextareaRow({
  label,
  field,
  rows = 2,
}: {
  label: string
  field: Field<string>
  rows?: number
}): ReactElement {
  const f = useField(field)
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <textarea
        rows={rows}
        className={`${fieldInputClass} resize-y`}
        value={f.value}
        onChange={(e) => f.set(e.target.value)}
        onBlur={f.markTouched}
      />
      {f.touched && f.errors[0] !== undefined && <FieldError message={f.errors[0]} />}
    </label>
  )
}

export function PriorityRow({ field }: { field: Field<Priority> }): ReactElement {
  const f = useField(field)
  return (
    <label className="flex flex-col gap-1">
      <Label>Priority</Label>
      <select
        className={fieldInputClass}
        value={f.value}
        onChange={(e) => f.set(e.target.value as Priority)}
      >
        <option value="low">Low</option>
        <option value="med">Medium</option>
        <option value="high">High</option>
      </select>
    </label>
  )
}

export function DateRow({ label, field }: { label: string; field: Field<string> }): ReactElement {
  const f = useField(field)
  return (
    <label className="flex flex-col gap-1">
      <Label>{label}</Label>
      <input
        type="date"
        className={fieldInputClass}
        value={f.value || ''}
        onChange={(e) => f.set(e.target.value)}
        onBlur={f.markTouched}
      />
      {f.touched && f.errors[0] !== undefined && <FieldError message={f.errors[0]} />}
    </label>
  )
}

export { fieldInputClass }
