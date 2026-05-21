/**
 * Active filter chips. Reads selected priority/label/assignee sets from
 * board controller, renders chips, and toggles individual entries.
 */

import { use, useQuery, useRoot } from '@kontsedal/olas-react'
import { X } from 'lucide-react'
import type { Priority } from '../../api'
import type { AppApi } from '../../app.controller'
import { cx } from '../../ui'

const ALL_PRIORITIES: Priority[] = ['urgent', 'high', 'med', 'low']

const PRIORITY_HUE: Record<Priority, number> = {
  urgent: 18,
  high: 85,
  med: 270,
  low: 215,
}

export function FilterChips() {
  const app = useRoot<AppApi>()
  const labels = useQuery(app.labels)
  const selPri = use(app.board.selectedPriorities)
  const selLab = use(app.board.selectedLabelIds)
  const selAss = use(app.board.selectedAssigneeIds)
  const hasFilter = selPri.size > 0 || selLab.size > 0 || selAss.size > 0

  return (
    <div className="olas-filterchips">
      {ALL_PRIORITIES.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => app.board.togglePriority(p)}
          className={cx('olas-chip', selPri.has(p) && 'olas-chip-on')}
          style={{ ['--chip-hue' as string]: String(PRIORITY_HUE[p]) } as React.CSSProperties}
        >
          {p}
        </button>
      ))}
      {(labels.data ?? []).map((l) => (
        <button
          key={l.id}
          type="button"
          onClick={() => app.board.toggleLabel(l.id)}
          className={cx('olas-chip', selLab.has(l.id) && 'olas-chip-on')}
          style={{ ['--chip-hue' as string]: String(l.hue) } as React.CSSProperties}
        >
          {l.name}
        </button>
      ))}
      {hasFilter && (
        <button type="button" className="olas-chip-clear" onClick={app.board.clearFilters}>
          <X size={12} /> Clear
        </button>
      )}
    </div>
  )
}
