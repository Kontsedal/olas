import { use, useQuery, useRoot } from '@kontsedal/olas-react'
import type { AppApi } from '../../app.controller'
import { Avatar, cx } from '../../ui'

export function AssigneesRow() {
  const app = useRoot<AppApi>()
  const users = useQuery(app.users)
  const array = app.cardDetail.form.fields.assigneeIds
  const value = use(array.value) as readonly string[]
  const selectedSet = new Set(value)

  return (
    <div className="olas-detail-row">
      <div className="olas-field-label">Assignees</div>
      <div className="olas-pill-row">
        {(users.data ?? []).map((u) => {
          const isOn = selectedSet.has(u.id)
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => {
                // Re-build the array as a snapshot.
                const next = new Set(value)
                if (next.has(u.id)) next.delete(u.id)
                else next.add(u.id)
                array.clear()
                for (const id of next) array.add(id)
              }}
              className={cx('olas-pill', isOn && 'olas-pill-on')}
            >
              <Avatar name={u.name} hue={u.hue} size="sm" />
              <span>{u.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
