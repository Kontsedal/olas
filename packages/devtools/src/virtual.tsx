// Windowed rendering for the panel's long views. The approach is the one
// `examples/virtualized-table` gets from `@tanstack/react-virtual`: keep a
// size per row (estimated until measured), prefix-sum them into offsets, and
// mount only the rows that intersect the viewport plus an overscan margin.
// Written here, with no dependency, because the published panel ships none.

import {
  createElement,
  Fragment,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

/**
 * The viewport height assumed before the scroller has a measured size: on the
 * first paint, and always in jsdom, which lays nothing out.
 */
const FALLBACK_VIEWPORT = 600

export type VirtualListProps = {
  count: number
  /** Height estimate for row `index`, in px, used until the row is measured. */
  estimate: (index: number) => number
  /** A stable key per row. Measured sizes are remembered by it. */
  getKey: (index: number) => string
  /** One DOM element per row. */
  renderRow: (index: number) => ReactNode
  /** Rows mounted past each edge of the viewport. */
  overscan?: number
  /** The row container: `ul` for `<li>` rows, `div` otherwise. */
  as?: 'ul' | 'div'
  className?: string
  role?: string
  label: string
  /** The row container's own top and bottom padding, in px. */
  pad?: number
  /** Scroll row `scrollToIndex` into view, once for each distinct `scrollNonce`. */
  scrollToIndex?: number
  scrollNonce?: number
}

/** The smallest `i` with `offsets[i] > y`. `offsets` ascends. */
function firstAfter(offsets: readonly number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((offsets[mid] as number) > y) hi = mid
    else lo = mid + 1
  }
  return lo
}

export function VirtualList(props: VirtualListProps): ReactElement {
  const { count, estimate, getKey, renderRow, overscan = 8, pad = 0 } = props
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLElement>(null)
  const sizes = useRef(new Map<string, number>())
  const handled = useRef<number | undefined>(undefined)
  const jump = useRef<{ index: number; tries: number } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(0)
  const [, remeasured] = useState(0)

  const offsets = new Array<number>(count + 1)
  offsets[0] = 0
  for (let i = 0; i < count; i++) {
    offsets[i + 1] = (offsets[i] as number) + (sizes.current.get(getKey(i)) ?? estimate(i))
  }
  const total = offsets[count] as number
  const height = viewport > 0 ? viewport : FALLBACK_VIEWPORT
  const y = Math.max(0, scrollTop - pad)
  const start = Math.max(0, firstAfter(offsets, y) - 1 - overscan)
  const end = Math.min(count, firstAfter(offsets, y + height) + overscan)

  // Read each mounted row's size. A row's size is the distance to the next
  // row's top, so margins between rows count; the last row falls back to its
  // own height. A size of 0 means "not laid out" (jsdom) and is ignored.
  const measure = (): boolean => {
    const el = inner.current
    if (el === null) return false
    let changed = false
    const rects = Array.from(el.children, (c) => c.getBoundingClientRect())
    rects.forEach((r, k) => {
      const i = start + k
      if (i >= end) return
      const next = rects[k + 1]
      const size = next !== undefined ? next.top - r.top : r.height
      if (size <= 0) return
      const key = getKey(i)
      const prev = sizes.current.get(key) ?? estimate(i)
      if (Math.abs(prev - size) < 1) return
      sizes.current.set(key, size)
      changed = true
    })
    return changed
  }
  const measureRef = useRef(measure)
  measureRef.current = measure

  const observer = useMemo(
    () =>
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (measureRef.current()) remeasured((n) => n + 1)
          })
        : null,
    [],
  )

  useLayoutEffect(() => {
    if (measure()) remeasured((n) => n + 1)
    const el = inner.current
    if (observer === null || el === null) return
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => observer.disconnect()
  })

  useLayoutEffect(() => {
    const el = scroller.current as HTMLDivElement
    setViewport(el.clientHeight)
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(() => setViewport(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Jump: put the target a third of the way down the viewport. The first
  // offset is computed from estimates; measuring the rows it lands on can move
  // the target, so the jump re-aligns on the next renders until it holds.
  useLayoutEffect(() => {
    const { scrollToIndex: index, scrollNonce: nonce } = props
    if (nonce !== undefined && index !== undefined && index >= 0 && handled.current !== nonce) {
      handled.current = nonce
      jump.current = { index, tries: 0 }
    }
    const j = jump.current
    if (j === null) return
    const target = Math.max(0, (offsets[Math.min(j.index, count)] as number) + pad - height / 3)
    if (Math.abs(target - scrollTop) < 1 || j.tries >= 4) {
      jump.current = null
      return
    }
    j.tries++
    ;(scroller.current as HTMLDivElement).scrollTop = target
    setScrollTop(target)
  })

  const rows: ReactNode[] = []
  for (let i = start; i < end; i++) {
    rows.push(createElement(Fragment, { key: getKey(i) }, renderRow(i)))
  }
  return (
    <div
      ref={scroller}
      className="olas-devtools-vlist"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      {createElement(
        props.as ?? 'div',
        {
          ref: inner,
          className: props.className,
          role: props.role,
          'aria-label': props.label,
          style: {
            paddingTop: pad + (offsets[start] as number),
            paddingBottom: pad + total - (offsets[end] as number),
          },
        },
        rows,
      )}
    </div>
  )
}

/** Per-row open/closed state that outlives the row, so scrolling a row away keeps it. */
export type Toggles = {
  is(key: string, fallback: boolean): boolean
  toggle(key: string, fallback: boolean): void
  set(key: string, value: boolean): void
}

export function useToggles(): Toggles {
  const [map, setMap] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  return useMemo(
    () => ({
      is: (key, fallback) => map.get(key) ?? fallback,
      toggle: (key, fallback) => setMap((m) => new Map(m).set(key, !(m.get(key) ?? fallback))),
      set: (key, value) => setMap((m) => (m.get(key) === value ? m : new Map(m).set(key, value))),
    }),
    [map],
  )
}
