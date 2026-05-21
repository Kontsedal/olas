import { use, useQuery, useRoot } from '@kontsedal/olas-react'
import type { AppApi } from '../../app.controller'
import { cx } from '../../ui'

export function LabelsRow() {
  const app = useRoot<AppApi>()
  const labels = useQuery(app.labels)
  const array = app.cardDetail.form.fields.labelIds
  const value = use(array.value) as readonly string[]
  const selectedSet = new Set(value)

  return (
    <div className="olas-detail-row">
      <div className="olas-field-label">Labels</div>
      <div className="olas-pill-row">
        {(labels.data ?? []).map((l) => {
          const isOn = selectedSet.has(l.id)
          return (
            <button
              key={l.id}
              type="button"
              onClick={() => {
                const next = new Set(value)
                if (next.has(l.id)) next.delete(l.id)
                else next.add(l.id)
                array.clear()
                for (const id of next) array.add(id)
              }}
              className={cx('olas-pill-tag', !isOn && 'olas-pill-tag-off')}
              style={{ ['--label-hue' as string]: String(l.hue) } as React.CSSProperties}
            >
              <span className="olas-pill-tag-dot" aria-hidden />
              <span>{l.name}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
