// One row of the virtualized table. Subscribes ONLY to its own row signal.
//
// The render counter (rendered inline) is the receipt: edit a row's status,
// only that row's counter increments. Neighbour rows stay flat because their
// signals didn't change — that's the SPEC §11.1 fine-grained reactivity in
// action.

import type { ReadSignal } from '@kontsedal/olas-core'
import { use } from '@kontsedal/olas-react'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import type { Issue, Status } from '../api'
import { useApi } from './useApi'

const STATUS_LABELS: Record<Status, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

const STATUS_OPTIONS: readonly Status[] = ['todo', 'in_progress', 'review', 'done']

const PRIORITY_DOT: Record<Issue['priority'], string> = {
  urgent: 'bg-(--color-danger)',
  high: 'bg-(--color-warning)',
  medium: 'bg-(--color-accent)',
  low: 'bg-(--color-fg-mute)',
}

export type RowProps = {
  id: string
  ordered: readonly string[]
  height: number
}

export function Row({ id, ordered, height }: RowProps): ReactElement | null {
  const api = useApi()
  const sig = api.table.rowSignal(id)
  if (sig === null) return null
  return <RowInner sig={sig} id={id} ordered={ordered} height={height} />
}

function RowInner({
  sig,
  id,
  ordered,
  height,
}: {
  sig: ReadSignal<Issue>
  id: string
  ordered: readonly string[]
  height: number
}): ReactElement {
  const api = useApi()
  // Re-render counter — increments on every render of THIS row. Edit row N's
  // status and only row N's counter ticks. The proof.
  const renderCount = useRef(0)
  renderCount.current += 1

  const issue = use(sig)
  const selected = use(api.table.selection.isSelected(id))

  return (
    <div
      style={{ height }}
      data-row-id={id}
      className={`grid grid-cols-[36px_1fr_180px_120px_120px_56px] items-center gap-3 border-b border-(--color-border) px-3 text-sm transition-colors ${
        selected ? 'bg-(--color-accent)/10' : 'odd:bg-(--color-bg-elev) even:bg-(--color-bg-sunk)'
      }`}
    >
      <input
        type="checkbox"
        aria-label={`Select ${issue.title}`}
        checked={selected}
        onChange={() => {}}
        onClick={(e) => {
          api.table.selection.handleClick(
            id,
            { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey },
            ordered,
          )
        }}
        title="Shift-click for range · ⌘/Ctrl-click to toggle"
        className="size-3.5 accent-(--color-accent)"
      />
      <div className="flex items-center gap-2 min-w-0">
        <span className={`size-2 rounded-full ${PRIORITY_DOT[issue.priority]}`} />
        <span className="truncate font-mono text-[11px] text-(--color-fg-mute)">{issue.id}</span>
        <span className="truncate font-medium text-(--color-fg)">{issue.title}</span>
      </div>
      <span className="truncate text-(--color-fg-mute)">{issue.assignee}</span>
      <FlashOnChange epoch={issue.updatedAt}>
        <StatusCell
          id={id}
          current={issue.status}
          isPending={use(api.table.updateStatus.isPending)}
        />
      </FlashOnChange>
      <span className="font-mono text-[11px] text-(--color-fg-mute) tabular-nums">
        {new Date(issue.updatedAt).toISOString().slice(0, 10)}
      </span>
      <span
        title="Render counter for THIS row — only this row re-renders when its signal changes"
        className="text-right font-mono text-[10px] text-(--color-fg-mute) tabular-nums"
      >
        {renderCount.current}
      </span>
    </div>
  )
}

function StatusCell({
  id,
  current,
  isPending,
}: {
  id: string
  current: Status
  isPending: boolean
}): ReactElement {
  const api = useApi()
  return (
    <select
      aria-label="Status"
      value={current}
      disabled={isPending}
      onChange={(e) => {
        const next = e.target.value as Status
        api.table.updateStatus.run({ id, status: next }).catch(() => {})
      }}
      className={`w-full rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-0.5 text-xs ${
        current === 'done' ? 'text-(--color-success)' : 'text-(--color-fg)'
      } disabled:opacity-60`}
    >
      {STATUS_OPTIONS.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s]}
        </option>
      ))}
    </select>
  )
}

/** Brief background flash when `epoch` changes — visual proof of per-row reactivity. */
function FlashOnChange({
  epoch,
  children,
}: {
  epoch: number
  children: ReactElement
}): ReactElement {
  const [flashKey, setFlashKey] = useState(0)
  const prev = useRef(epoch)
  useEffect(() => {
    if (prev.current !== epoch) {
      prev.current = epoch
      setFlashKey((k) => k + 1)
    }
  }, [epoch])
  return (
    <div key={flashKey} className="row-flash rounded-md">
      {children}
    </div>
  )
}
