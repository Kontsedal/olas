import type { Field, Form } from '@kontsedal/olas-core'
import { useField, useRoot, useValue } from '@kontsedal/olas-react'
import { Plus, Trash2 } from 'lucide-react'
import { IconButton } from '../../ui'

type SubtaskForm = Form<{ text: Field<string>; done: Field<boolean> }>

/**
 * A stable React key per subtask.
 *
 * `key={idx}` is wrong on a list with a delete. Removing item 1 renumbers
 * every item after it, so React matches item 2's DOM node to item 1's data
 * and drops the last node instead of the removed one — the caret, the text
 * selection and any IME composition end up on the wrong row.
 *
 * The subtask model carries no id (see `api/types.ts`), but `array.items`
 * hands back the SAME `Form` handle for a surviving item across a `remove`
 * (`FieldArray.remove` splices the array and disposes only the removed
 * handle). So identity is available even though a name is not: mint a key
 * per handle and remember it in a `WeakMap`, which lets a disposed handle
 * and its key be collected together.
 */
const subtaskKeys = new WeakMap<object, string>()
let nextSubtaskKey = 0
const keyOf = (item: object): string => {
  let key = subtaskKeys.get(item)
  if (key === undefined) {
    nextSubtaskKey += 1
    key = `subtask-${nextSubtaskKey}`
    subtaskKeys.set(item, key)
  }
  return key
}

export function SubtasksRow() {
  const app = useRoot()
  const array = app.cardDetail.form.fields.subtasks
  const items = useValue(array.items)

  return (
    <div className="olas-detail-row">
      <div className="olas-detail-row-head">
        <div className="olas-field-label">Subtasks</div>
        <IconButton
          size="sm"
          label="Add subtask"
          onClick={() => array.add({ text: '', done: false })}
        >
          <Plus size={12} />
        </IconButton>
      </div>
      <ul className="olas-subtasks">
        {items.map((item, idx) => (
          <SubtaskRow key={keyOf(item)} item={item} idx={idx} />
        ))}
      </ul>
    </div>
  )
}

function SubtaskRow({ item, idx }: { item: SubtaskForm; idx: number }) {
  const app = useRoot()
  const array = app.cardDetail.form.fields.subtasks
  const textField = useField(item.fields.text)
  const doneField = useField(item.fields.done)

  return (
    <li className="olas-subtask">
      <input
        type="checkbox"
        checked={doneField.value}
        onChange={(e) => doneField.set(e.currentTarget.checked)}
        aria-label="Done"
      />
      <input
        type="text"
        value={textField.value}
        onChange={(e) => textField.set(e.currentTarget.value)}
        onBlur={textField.markTouched}
        placeholder="What needs doing?"
        className="olas-input olas-subtask-input"
      />
      <IconButton size="sm" label="Remove subtask" onClick={() => array.remove(idx)}>
        <Trash2 size={12} />
      </IconButton>
    </li>
  )
}
