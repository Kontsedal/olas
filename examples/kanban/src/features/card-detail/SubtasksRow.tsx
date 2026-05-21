import type { Field, Form } from '@kontsedal/olas-core'
import { use, useField, useRoot } from '@kontsedal/olas-react'
import { Plus, Trash2 } from 'lucide-react'
import type { AppApi } from '../../app.controller'
import { IconButton } from '../../ui'

type SubtaskForm = Form<{ text: Field<string>; done: Field<boolean> }>

export function SubtasksRow() {
  const app = useRoot<AppApi>()
  const array = app.cardDetail.form.fields.subtasks
  const items = use(array.items)

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
          <SubtaskRow key={idx} item={item} idx={idx} />
        ))}
      </ul>
    </div>
  )
}

function SubtaskRow({ item, idx }: { item: SubtaskForm; idx: number }) {
  const app = useRoot<AppApi>()
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
