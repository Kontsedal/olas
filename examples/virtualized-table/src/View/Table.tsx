// Virtualized table shell. `@tanstack/react-virtual` measures the scroller
// and tells us which row indices are visible; we render that slice using the
// per-row `<Row>` component which subscribes to its own row signal.

import { use } from '@kontsedal/olas-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { type ReactElement, useMemo, useRef } from 'react'
import { Row } from './Row'
import { useApi } from './useApi'

const ROW_HEIGHT = 38

export function Table(): ReactElement {
  const api = useApi()
  const visibleIds = use(api.table.visibleIds)
  const parentRef = useRef<HTMLDivElement | null>(null)

  // `useVirtualizer` allocates a small fixed-size window; row count can spike
  // to 50k without the DOM caring.
  const virt = useVirtualizer({
    count: visibleIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => visibleIds[index] ?? index,
  })

  // Stable reference to the ordered id list — passed to each Row so that
  // shift-click ranges are computed against the same array Row sees.
  const ordered = useMemo(() => visibleIds, [visibleIds])

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-(--color-border) bg-(--color-bg-elev) shadow-[var(--shadow-card)]">
      <div className="grid grid-cols-[36px_1fr_180px_120px_120px_56px] items-center gap-3 border-b border-(--color-border) bg-(--color-bg-sunk) px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-(--color-fg-mute)">
        <span />
        <span>Issue</span>
        <span>Assignee</span>
        <span>Status</span>
        <span>Updated</span>
        <span className="text-right">Renders</span>
      </div>
      <div ref={parentRef} className="flex-1 overflow-auto">
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vItem) => {
            const id = visibleIds[vItem.index]
            if (id === undefined) return null
            return (
              <div
                key={vItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${vItem.start}px)`,
                }}
              >
                <Row id={id} ordered={ordered} height={ROW_HEIGHT} />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
