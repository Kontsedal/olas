import { use, useRoot } from '@kontsedal/olas-react'
import { Activity, Eraser } from 'lucide-react'
import type { AppApi } from '../../app.controller'
import { cx, IconButton } from '../../ui'

export function ActivityFeed() {
  const app = useRoot<AppApi>()
  const events = use(app.activity.events)
  const visible = use(app.preferences.prefs).showActivity

  if (!visible) return null

  return (
    <aside className="olas-activity" aria-label="Activity">
      <header className="olas-activity-head">
        <span className="olas-activity-title">
          <Activity size={14} /> Activity
        </span>
        <IconButton size="sm" label="Clear activity" onClick={app.activity.clear}>
          <Eraser size={12} />
        </IconButton>
      </header>
      <ul className="olas-activity-list">
        {events.length === 0 ? (
          <li className="olas-activity-empty">Quiet for now.</li>
        ) : (
          events.map((e) => (
            <li
              key={e.id}
              className={cx(
                'olas-activity-item',
                `olas-activity-${e.kind}`,
                e.isRemote && 'olas-activity-remote',
              )}
            >
              <span className="olas-activity-dot" aria-hidden />
              <span className="olas-activity-text">{e.text}</span>
              <span className="olas-activity-time">{relTime(e.ts)}</span>
            </li>
          ))
        )}
      </ul>
    </aside>
  )
}

function relTime(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  return `${Math.floor(diff / 86_400_000)}d`
}
