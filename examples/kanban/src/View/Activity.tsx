// Activity feed — subscribes to the boardController's `recentActivity` signal.
// The activity emitter is provided to descendants via `activityScope`, so both
// boardController and cardEditorController publish into the same stream
// without prop-drilling. Spec §10.3.

import { use } from '@olas/react'
import { AlertCircle, ArrowRight, Check } from 'lucide-react'
import type { ReactElement } from 'react'
import { useApi } from './useApi'

export function Activity(): ReactElement {
  const api = useApi()
  const events = use(api.board.recentActivity)

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-bg-elev) p-3 shadow-[var(--shadow-card)]">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.07em] text-(--color-fg-mute)">
        Activity
      </h3>
      {events.length === 0 ? (
        <p className="text-xs text-(--color-fg-mute)">
          Move a card, edit one, or add a new one — events land here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-72 overflow-auto pr-1">
          {events.map((ev, idx) => (
            <li key={`${ev.ts}-${idx}`} className="flex items-start gap-2 text-xs leading-tight">
              <span className="mt-0.5 shrink-0">
                {ev.kind === 'move' && <ArrowRight className="size-3 text-(--color-accent)" />}
                {ev.kind === 'save' && <Check className="size-3 text-(--color-success)" />}
                {ev.kind === 'error' && <AlertCircle className="size-3 text-(--color-danger)" />}
              </span>
              <span className="flex-1 text-(--color-fg)">{ev.text}</span>
              <time className="shrink-0 text-(--color-fg-mute) tabular-nums">
                {formatTime(ev.ts)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function pad(n: number): string {
  return n.toString().padStart(2, '0')
}
