// Top-level layout. Header (filter + bulk actions) + the virtualized table
// + the floating devtools launcher. All real reactivity happens via the
// table controller, not React state.

import { DevtoolsLauncher } from '@kontsedal/olas-devtools'
import { OlasProvider, use } from '@kontsedal/olas-react'
import { Layers, Sparkles, X } from 'lucide-react'
import type { ReactElement } from 'react'
import type { Status } from '../api'
import type { AppRoot } from '../app'
import { Table } from './Table'
import { useApi } from './useApi'

const STATUS_OPTIONS: readonly Status[] = ['todo', 'in_progress', 'review', 'done']
const STATUS_LABELS: Record<Status, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
}

export function App({ root }: { root: AppRoot }): ReactElement {
  return (
    <OlasProvider root={root}>
      <div className="flex h-screen min-h-0 w-full flex-col gap-3 p-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-(--color-accent) text-(--color-accent-fg)">
              <Layers className="size-4" strokeWidth={2.5} />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Olas Virtualized Table</h1>
              <p className="text-xs text-(--color-fg-mute)">
                50,000 rows · Map&lt;id, Signal&lt;Issue&gt;&gt; · per-row reactivity ·
                shift/⌘-click ranges
              </p>
            </div>
          </div>
          <CountsAndFilter />
        </header>
        <BulkBar />
        <div className="flex min-h-0 flex-1 flex-col">
          <Table />
        </div>
        <Legend />
        <DevtoolsLauncher root={root} defaultTab="tree" urlHashKey="vtable" />
      </div>
    </OlasProvider>
  )
}

function CountsAndFilter(): ReactElement {
  const api = useApi()
  const visible = use(api.table.rowCount)
  const filterValue = use(api.table.filter)
  return (
    <div className="flex items-center gap-3">
      <span className="rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs font-mono tabular-nums text-(--color-fg-mute)">
        {visible.toLocaleString()} / {api.table.totalRowCount.toLocaleString()}
      </span>
      <input
        type="search"
        placeholder="Filter by title…"
        value={filterValue}
        onChange={(e) => api.table.filter.set(e.target.value)}
        className="w-64 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-sm outline-none focus:border-(--color-accent) focus:ring-2 focus:ring-(--color-accent)/30"
      />
    </div>
  )
}

function BulkBar(): ReactElement | null {
  const api = useApi()
  const size = use(api.table.selection.size)
  const isPending = use(api.table.updateStatus.isPending)
  if (size === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-(--color-accent) bg-(--color-accent)/10 px-3 py-2 text-sm">
      <span className="font-medium text-(--color-fg)">
        {size.toLocaleString()} selected
        <span className="ml-2 text-xs font-normal text-(--color-fg-mute)">
          shift-click for ranges · ⌘/Ctrl-click to toggle
        </span>
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {STATUS_OPTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={isPending}
            onClick={() => void api.table.bulkSetStatus(s)}
            className="rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs font-medium text-(--color-fg) hover:border-(--color-accent) hover:text-(--color-accent) disabled:opacity-50"
          >
            Mark → {STATUS_LABELS[s]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => api.table.selection.clear()}
          aria-label="Clear selection"
          title="Clear selection"
          className="inline-flex items-center gap-1 rounded-md border border-(--color-border) bg-(--color-bg-elev) px-2 py-1 text-xs text-(--color-fg-mute) hover:text-(--color-fg)"
        >
          <X className="size-3" />
        </button>
      </div>
    </div>
  )
}

function Legend(): ReactElement {
  return (
    <footer className="flex flex-wrap items-center gap-2 text-[11px] text-(--color-fg-mute)">
      <Sparkles className="size-3" />
      Edit a single status — only that row's render counter ticks. Bulk-edit with selection — only
      the affected rows re-render. The other 49,999 rows stay frozen.
    </footer>
  )
}
