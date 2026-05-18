// @vitest-environment jsdom
//
// Component test using `fakeField` from @olas/core/testing. We render the
// `<FieldRow>` cell in isolation against a fake Field, then assert that typing
// into the input updates the field's value and that an error message renders
// when the field has errors.

import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeField } from '@olas/core/testing'
import { useField } from '@olas/react'
import type { Field } from '@olas/core'
import type { ReactElement } from 'react'

// Local re-implementation of FieldRow so we don't have to extract it from the
// CardEditor module. Mirrors `examples/kanban/src/View/CardEditor.tsx:FieldRow`.
function FieldRow({ label, field }: { label: string; field: Field<string> }): ReactElement {
  const f = useField(field)
  return (
    <label>
      <span>{label}</span>
      <input
        value={f.value}
        onChange={(e) => f.set(e.target.value)}
        onBlur={f.markTouched}
      />
      {f.touched && f.errors[0] !== undefined && <span role="alert">{f.errors[0]}</span>}
    </label>
  )
}

describe('<FieldRow> with fakeField', () => {
  test('typing updates the field and the rendered value', async () => {
    const user = userEvent.setup()
    const field = fakeField<string>('')
    render(<FieldRow label="Title" field={field} />)

    const input = screen.getByLabelText('Title') as HTMLInputElement
    expect(input.value).toBe('')
    await user.type(input, 'hello')
    expect(input.value).toBe('hello')
  })

  test('error message renders only after the field is touched', async () => {
    const user = userEvent.setup()
    const field = fakeField<string>('', {
      errors: ['Required'],
      isValid: false,
    })
    render(<FieldRow label="Title" field={field} />)

    // Initially untouched — error hidden.
    expect(screen.queryByRole('alert')).toBeNull()

    // Blur marks touched; the alert appears.
    const input = screen.getByLabelText('Title')
    await user.click(input)
    await user.tab()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Required')
  })
})
