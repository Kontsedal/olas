import type { DebugCacheEntry, DebugEvent, ReadSignal, Root } from '@kontsedal/olas-core'
import { useValue } from '@kontsedal/olas-react'
import {
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type Diff, diffValues, hasChange } from './diff'
import { badgeLabel, eventPayload, eventTarget, laneOf, timelineKindClass } from './events'
import { formatPath, formatTime } from './format'
import { JsonView } from './JsonView'
import { Omnibox } from './Omnibox'
import type { SearchHit } from './search'
import {
  type CacheEntry,
  type ControllerNode,
  DevtoolsStore,
  type FieldEntry,
  type MutationEntry,
  type TimelineEvent,
} from './store'
import { DEVTOOLS_CSS } from './styles'
import {
  ancestorKeys,
  entryKey,
  isSignalLike,
  pathKey,
  type SignalLike,
  toSearchText,
} from './util'
import { type Toggles, useToggles, VirtualList } from './virtual'

export type DevtoolsTab = 'timeline' | 'tree' | 'cache' | 'inspector' | 'mutations' | 'fields'

/** Each tab: its id, its label, and the short label a narrow panel shows. */
const TAB_LABELS: ReadonlyArray<readonly [DevtoolsTab, string, string]> = [
  ['timeline', 'Timeline', 'Time'],
  ['tree', 'Tree', 'Tree'],
  ['cache', 'Cache', 'Cache'],
  ['inspector', 'Inspector', 'Insp'],
  ['mutations', 'Mutations', 'Mut'],
  ['fields', 'Fields', 'Fld'],
]
const TABS: readonly DevtoolsTab[] = TAB_LABELS.map(([name]) => name)

export type DevtoolsPanelProps = {
  /** The root to inspect. The panel subscribes to `root.debug` on mount. */
  root: Pick<Root<unknown>, 'debug'>
  /** Initial tab. Default: `'timeline'`. */
  defaultTab?: DevtoolsTab
  /** Cap on each event log. Default: 100. */
  maxEntries?: number
  /** Capacity of the timeline's ring buffer. Default: 10,000. */
  maxTimelineEntries?: number
  /**
   * Persist filter state to the URL hash under this key. When set,
   * reloading the page restores filter + tab. Default: no persistence.
   */
  urlHashKey?: string
}

/** A search jump: the row to scroll to and highlight. `nonce` makes a repeat jump fire again. */
type Focus = { tab: DevtoolsTab; key: string; nonce: number }

/**
 * Drop-in devtools panel for an Olas root.
 *
 * Features:
 *  - **Omnibox** (`/` to focus) — one search over controllers, queries,
 *    mutations, form fields and payloads; Enter jumps to the match.
 *  - **Timeline** — every event in a ring buffer, grouped by cause, with one
 *    lane per plugin that can be shown or hidden.
 *  - **Tree / Cache / Inspector / Mutations / Fields** — each a windowed list
 *    that mounts only the rows in view.
 *  - **Filter** field per tab — text-matches kind, path, name, payload.
 *  - **Pause** toggle freezes the log without stopping ingestion.
 *
 * Styled inline (no CSS import needed) and scoped to the `.olas-devtools-*`
 * class prefix. Hosts override the palette via `--olas-*` custom properties.
 * Spec §14.
 */
export function DevtoolsPanel(props: DevtoolsPanelProps): ReactElement {
  const { root, defaultTab = 'timeline', maxEntries, maxTimelineEntries, urlHashKey } = props
  const store = useMemo(
    () =>
      new DevtoolsStore({
        ...(maxEntries !== undefined ? { maxEntries } : {}),
        ...(maxTimelineEntries !== undefined ? { maxTimelineEntries } : {}),
        // Live panel — rAF-coalesce so a burst of N events flushes in one
        // React render per frame, not N. Tests construct DevtoolsStore
        // directly without this option and stay synchronous.
        coalesce: 'raf',
      }),
    [maxEntries, maxTimelineEntries],
  )
  useEffect(() => store.attach(root), [root, store])

  // Initial state read from URL hash if `urlHashKey` is set.
  const initial = useMemo(() => readUrlHash(urlHashKey, defaultTab), [urlHashKey, defaultTab])
  const [tab, setTab] = useState<DevtoolsTab>(initial.tab)
  const [paused, setPaused] = useState(false)
  // Filters are kept per-tab so switching back doesn't lose the query.
  const [filters, setFilters] = useState<Record<DevtoolsTab, string>>(initial.filters)
  const filter = filters[tab]
  const setFilter = (q: string) => setFilters((prev) => ({ ...prev, [tab]: q }))

  // The input stays responsive (`value={filter}`), but filtering runs against a
  // DEBOUNCED value so typing doesn't re-filter the whole log on every
  // keystroke (T6.3). Keyed by tab: switching tabs applies that tab's own
  // stored filter at once, and only typing waits out the debounce.
  const [debounced, setDebounced] = useState({ tab, value: filter })
  useEffect(() => {
    const id = setTimeout(() => setDebounced({ tab, value: filter }), 150)
    return () => clearTimeout(id)
  }, [tab, filter])
  const debouncedFilter = debounced.tab === tab ? debounced.value : filter

  // Persist tab + filters back to the URL hash on every change.
  useEffect(() => {
    if (urlHashKey === undefined) return
    writeUrlHash(urlHashKey, { tab, filters })
  }, [urlHashKey, tab, filters])

  const liveTree = useValue(store.tree$)
  const liveCache = useValue(store.cache$)
  const liveMutations = useValue(store.mutations$)
  const liveFields = useValue(store.fields$)
  const liveEvents = useValue(store.events$)
  const dropped = useValue(store.droppedEvents$)
  // The cache inspector is event-driven: the store seeds this from
  // `root.debug.queryEntries()` on attach and refreshes it whenever a cache
  // event lands — no polling interval (the old 800ms poll is gone).
  const liveCacheState = useValue(store.cacheState$)

  // When paused, snapshot once and keep showing that frozen state.
  const [frozen, setFrozen] = useState<{
    tree: ControllerNode
    cache: CacheEntry[]
    mutations: MutationEntry[]
    fields: FieldEntry[]
    events: TimelineEvent[]
    cacheState: DebugCacheEntry[]
  } | null>(null)
  useEffect(() => {
    if (paused) {
      setFrozen({
        tree: liveTree,
        cache: liveCache,
        mutations: liveMutations,
        fields: liveFields,
        events: liveEvents,
        cacheState: liveCacheState,
      })
    } else {
      setFrozen(null)
    }
    // We only re-snapshot when the toggle flips, not on every event.
  }, [paused])

  const tree = frozen?.tree ?? liveTree
  const cache = frozen?.cache ?? liveCache
  const mutations = frozen?.mutations ?? liveMutations
  const fields = frozen?.fields ?? liveFields
  const events = frozen?.events ?? liveEvents
  const cacheState = frozen?.cacheState ?? liveCacheState

  // Lanes are hidden panel-wide, so a hidden plugin stays hidden across tabs.
  const [hiddenLanes, setHiddenLanes] = useState<ReadonlySet<string>>(() => new Set())
  const toggleLane = (lane: string): void =>
    setHiddenLanes((prev) => {
      const next = new Set(prev)
      if (!next.delete(lane)) next.add(lane)
      return next
    })

  // ---- omnibox + jump ------------------------------------------------------
  const omnibox = useRef<HTMLInputElement>(null)
  const [focus, setFocus] = useState<Focus | null>(null)
  const search = useCallback((q: string) => store.search(q), [store])
  const dataRev = useMemo(() => ({}), [liveTree, liveEvents, liveCacheState])
  const jump = (hit: SearchHit): void => {
    setTab(hit.tab)
    // A filter or a hidden lane on the target tab could hide the match.
    setFilters((prev) => (prev[hit.tab] === '' ? prev : { ...prev, [hit.tab]: '' }))
    setDebounced({ tab: hit.tab, value: '' })
    const lane = hit.lane
    if (lane !== undefined) {
      setHiddenLanes((prev) => {
        if (!prev.has(lane)) return prev
        const next = new Set(prev)
        next.delete(lane)
        return next
      })
    }
    setFocus((f) => ({ tab: hit.tab, key: hit.key, nonce: (f?.nonce ?? 0) + 1 }))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return
    // A `/` typed into a field is text, not a shortcut.
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) {
      return
    }
    e.preventDefault()
    omnibox.current?.focus()
  }
  const focusFor = (t: DevtoolsTab): Focus | undefined => (focus?.tab === t ? focus : undefined)
  const counts: Record<DevtoolsTab, number> = {
    timeline: liveEvents.length,
    tree: countLiveControllers(liveTree),
    cache: liveCache.length,
    inspector: liveCacheState.length,
    mutations: liveMutations.length,
    fields: liveFields.length,
  }

  return (
    <div className="olas-devtools" data-testid="olas-devtools" tabIndex={-1} onKeyDown={onKeyDown}>
      <style>{DEVTOOLS_CSS}</style>
      <Omnibox search={search} onPick={jump} rev={dataRev} inputRef={omnibox} />
      <div className="olas-devtools-tabs" role="tablist">
        {TAB_LABELS.map(([name, label, short]) => (
          <Tab
            key={name}
            name={name}
            current={tab}
            setTab={setTab}
            label={label}
            short={short}
            count={counts[name]}
          />
        ))}
        <button
          type="button"
          aria-pressed={paused}
          className={paused ? 'olas-devtools-pause olas-devtools-pause-on' : 'olas-devtools-pause'}
          onClick={() => setPaused(!paused)}
          title={paused ? 'Resume live updates' : 'Pause live updates'}
        >
          <span aria-hidden="true">{paused ? '▶' : '⏸'}</span>
          <span className="olas-devtools-pause-text">{paused ? ' Resume' : ' Pause'}</span>
        </button>
        <button
          className="olas-devtools-clear"
          type="button"
          onClick={() => store.clearLogs()}
          title="Clear logs"
        >
          <span className="olas-devtools-clear-text">Clear</span>
          <span className="olas-devtools-clear-icon" aria-hidden="true">
            ✕
          </span>
        </button>
      </div>

      {tab !== 'tree' && (
        <div className="olas-devtools-filter">
          <input
            type="search"
            value={filter}
            placeholder={`Filter ${tab}…`}
            onChange={(e) => setFilter(e.target.value)}
          />
          {filter !== '' && (
            <button type="button" onClick={() => setFilter('')} aria-label="Clear filter">
              ✕
            </button>
          )}
        </div>
      )}

      <div className="olas-devtools-body" role="tabpanel">
        {tab === 'timeline' && (
          <TimelineView
            events={events}
            filter={debouncedFilter}
            hidden={hiddenLanes}
            onToggleLane={toggleLane}
            dropped={dropped}
            capacity={store.maxTimelineEntries}
            focus={focusFor('timeline')}
          />
        )}
        {tab === 'tree' && (
          <TreeView tree={tree} mutations={liveMutations} focus={focusFor('tree')} />
        )}
        {tab === 'cache' && <CacheView entries={cache} filter={debouncedFilter} />}
        {tab === 'inspector' && (
          <InspectorView
            entries={cacheState}
            filter={debouncedFilter}
            focus={focusFor('inspector')}
          />
        )}
        {tab === 'mutations' && <MutationsView entries={mutations} filter={debouncedFilter} />}
        {tab === 'fields' && <FieldsView entries={fields} filter={debouncedFilter} />}
      </div>
    </div>
  )
}

function Tab(props: {
  name: DevtoolsTab
  current: DevtoolsTab
  setTab: (t: DevtoolsTab) => void
  label: string
  short: string
  count: number
}): ReactElement {
  const selected = props.current === props.name
  return (
    <button
      role="tab"
      type="button"
      aria-selected={selected}
      title={props.label}
      className="olas-devtools-tab"
      onClick={() => props.setTab(props.name)}
    >
      <span className="olas-devtools-tab-label-full">{props.label}</span>
      <span className="olas-devtools-tab-label-short" aria-hidden="true">
        {props.short}
      </span>
      {props.count > 0 && (
        <span className="olas-devtools-tab-count" aria-hidden="true">
          {props.count}
        </span>
      )}
    </button>
  )
}

function countLiveControllers(tree: ControllerNode): number {
  // Only the placeholder root wrapper is excluded: count its descendants.
  const live = (node: ControllerNode): number => {
    let total = node.state !== 'disposed' ? 1 : 0
    for (const c of node.children) total += live(c)
    return total
  }
  let total = 0
  for (const c of tree.children) total += live(c)
  return total
}

// ===========================================================================
// Tree — flattened to one row per visible node, then windowed
// ===========================================================================

type TreeRow = { node: ControllerNode; key: string; depth: number }

/** Depth-first rows, skipping the children of collapsed nodes. */
function flattenTree(tree: ControllerNode, collapsed: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (node: ControllerNode, depth: number): void => {
    for (const c of node.children) {
      const key = pathKey(c.path)
      out.push({ node: c, key, depth })
      if (!collapsed.has(key)) walk(c, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

function TreeView({
  tree,
  mutations,
  focus,
}: {
  tree: ControllerNode
  mutations: MutationEntry[]
  focus: Focus | undefined
}): ReactElement {
  // Roll up pending-mutation counts per controller path. A "pending" mutation
  // is one whose last entry is `run` with no matching success/error for the
  // same (path, name).
  const pending = useMemo(() => rollupPending(mutations), [mutations])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggles = useToggles()
  const rows = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed])
  // A jump into a collapsed subtree opens the target's ancestors.
  useEffect(() => {
    if (focus === undefined) return
    const up = ancestorKeys(focus.key)
    setCollapsed((c) =>
      up.some((k) => c.has(k)) ? new Set([...c].filter((k) => !up.includes(k))) : c,
    )
  }, [focus?.nonce])
  if (tree.children.length === 0) {
    return <Empty title="No controllers yet" hint="The root hasn't constructed any controllers." />
  }
  const collapse = (key: string): void =>
    setCollapsed((c) => {
      const next = new Set(c)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const focusIndex = focus === undefined ? -1 : rows.findIndex((r) => r.key === focus.key)
  return (
    <VirtualList
      count={rows.length}
      getKey={(i) => (rows[i] as TreeRow).key}
      estimate={(i) => treeRowEstimate(rows[i] as TreeRow, toggles)}
      renderRow={(i) => {
        const row = rows[i] as TreeRow
        return (
          <TreeItem
            row={row}
            pending={pending.get(row.node.path.join('>')) ?? 0}
            collapsed={collapsed.has(row.key)}
            onCollapse={() => collapse(row.key)}
            varsOpen={toggles.is(`v${row.key}`, true)}
            onVars={() => toggles.toggle(`v${row.key}`, true)}
            propsOpen={toggles.is(`p${row.key}`, false)}
            onProps={() => toggles.toggle(`p${row.key}`, false)}
            hit={focus?.key === row.key}
          />
        )
      }}
      role="tree"
      label="Controller tree"
      className="olas-devtools-tree"
      pad={10}
      scrollToIndex={focusIndex}
      scrollNonce={focus?.nonce}
    />
  )
}

function treeRowEstimate(row: TreeRow, toggles: Toggles): number {
  const vars = row.node.debug ? Object.keys(row.node.debug).length : 0
  let h = 24
  if (vars > 0 && toggles.is(`v${row.key}`, true)) h += 24 + vars * 19
  if (toggles.is(`p${row.key}`, false)) h += 40
  return h
}

function rollupPending(entries: readonly MutationEntry[]): Map<string, number> {
  const inFlight = new Map<string, number>() // (path|mutation id) → count
  const out = new Map<string, number>() // path → pending count
  for (const e of entries) {
    const key = `${e.path.join('>')}#${e.mutationId ?? ''}`
    const pathKey = e.path.join('>')
    if (e.kind === 'run') {
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
      out.set(pathKey, (out.get(pathKey) ?? 0) + 1)
    } else if (e.kind === 'success' || e.kind === 'error') {
      // Only a settle for a (path, mutation id) with a run in flight lowers the
      // path's count: the run may predate the panel, a Clear, or the log's
      // window, and another mutation's badge must not drop with it.
      const n = inFlight.get(key) ?? 0
      if (n === 0) continue
      inFlight.set(key, n - 1)
      const p = out.get(pathKey) ?? 0
      if (p > 0) out.set(pathKey, p - 1)
    }
  }
  return out
}

function TreeItem(props: {
  row: TreeRow
  pending: number
  collapsed: boolean
  onCollapse: () => void
  varsOpen: boolean
  onVars: () => void
  propsOpen: boolean
  onProps: () => void
  hit: boolean
}): ReactElement {
  const { row, pending, varsOpen, propsOpen, hit } = props
  const { node, depth } = row
  const name = node.path[node.path.length - 1] ?? '?'
  const disposed = node.state === 'disposed'
  const hasChildren = node.children.length > 0
  const propsPreview = useMemo(() => summarizeProps(node.props), [node.props])
  const canExpandProps = node.props !== undefined && node.props !== null
  const debugKeys = node.debug ? Object.keys(node.debug) : []
  const indents: ReactElement[] = []
  for (let i = 0; i < depth; i++) {
    indents.push(<span key={i} className="olas-devtools-tree-indent" aria-hidden="true" />)
  }
  let cls = 'olas-devtools-tree-item'
  if (disposed) cls += ' olas-devtools-tree-item-disposed'
  if (hit) cls += ' olas-devtools-hit'
  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !props.collapsed : undefined}
      aria-selected={hit}
      className={cls}
    >
      {indents}
      <div className="olas-devtools-tree-content">
        <span className="olas-devtools-tree-row">
          {hasChildren ? (
            <button
              type="button"
              className="olas-devtools-tree-toggle"
              aria-label={`${props.collapsed ? 'Expand' : 'Collapse'} ${name}`}
              onClick={props.onCollapse}
            >
              <span
                aria-hidden="true"
                className={`olas-devtools-chevron${props.collapsed ? '' : ' olas-devtools-chevron-open'}`}
              >
                ›
              </span>
            </button>
          ) : (
            <span className="olas-devtools-tree-leaf" aria-hidden="true" />
          )}
          <span className="olas-devtools-tree-name">{name}</span>
          <span
            className={`olas-devtools-tree-state-${node.state}`}
            title={
              node.disposedAt !== undefined
                ? `Disposed at ${formatTime(node.disposedAt)}; values frozen then`
                : undefined
            }
          >
            {node.state}
          </span>
          {pending > 0 && (
            <span
              className="olas-devtools-tree-pending"
              title="pending mutations on this controller"
            >
              {pending} pending
            </span>
          )}
          {debugKeys.length > 0 && (
            <button
              type="button"
              className="olas-devtools-tree-vars-toggle"
              aria-expanded={varsOpen}
              onClick={props.onVars}
              title={varsOpen ? 'Hide variables' : 'Show variables'}
            >
              {debugKeys.length} var{debugKeys.length === 1 ? '' : 's'}
            </button>
          )}
          {canExpandProps && (
            <button
              type="button"
              className="olas-devtools-tree-props-toggle"
              aria-expanded={propsOpen}
              onClick={props.onProps}
              title={propsOpen ? 'Hide props' : 'Show full props'}
            >
              {propsPreview}
            </button>
          )}
        </span>
        {varsOpen && node.debug && debugKeys.length > 0 && (
          <div className="olas-devtools-tree-vars">
            {debugKeys.map((k) => (
              <DebugVar key={k} name={k} value={(node.debug as Record<string, unknown>)[k]} />
            ))}
          </div>
        )}
        {propsOpen && canExpandProps && (
          <div className="olas-devtools-tree-props">
            <JsonView value={node.props} />
          </div>
        )}
      </div>
    </div>
  )
}

// ---- ctx.debug variables (reactive) ----

/** One `ctx.debug({...})` variable row: `name: value` (reactive if a signal). */
function DebugVar({ name, value }: { name: string; value: unknown }): ReactElement {
  return (
    <div className="olas-devtools-var-row">
      <span className="olas-devtools-var-name">{name}:</span>
      {isSignalLike(value) ? (
        <ReactiveValue signal={value} />
      ) : typeof value === 'function' ? (
        <span className="olas-devtools-json-summary">
          [fn{(value as { name?: string }).name ? ` ${(value as { name: string }).name}` : ''}]
        </span>
      ) : (
        <span className="olas-devtools-var-value">
          <JsonView value={value} />
        </span>
      )}
    </div>
  )
}

/** Subscribes to a signal via `use()` so the rendered value updates live. */
function ReactiveValue({ signal }: { signal: SignalLike }): ReactElement {
  const value = useValue(signal as unknown as ReadSignal<unknown>)
  return (
    <span className="olas-devtools-var-value">
      <JsonView value={value} />
    </span>
  )
}

/** Build a one-line props summary for the tree row. */
function summarizeProps(props: unknown): string {
  if (props === null || props === undefined) return ''
  if (typeof props === 'string') return `"${truncate(props, 24)}"`
  if (typeof props === 'number' || typeof props === 'boolean') return String(props)
  if (Array.isArray(props)) return `[${props.length}]`
  if (typeof props === 'object') {
    const keys = Object.keys(props as Record<string, unknown>)
    if (keys.length === 0) return '{}'
    const parts = keys.slice(0, 2).map((k) => {
      const v = (props as Record<string, unknown>)[k]
      return `${k}: ${shortValue(v)}`
    })
    return `{ ${parts.join(', ')}${keys.length > 2 ? `, +${keys.length - 2}` : ''} }`
  }
  return String(props)
}

function shortValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return `"${truncate(v, 16)}"`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.length}]`
  if (typeof v === 'object') return `{${Object.keys(v as object).length}}`
  return String(v)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

// ===========================================================================
// Timeline — unified, causally-grouped event stream (the headline view)
// ===========================================================================

/** Events an open cause-group mounts at a time; "Show more" adds another page. */
const GROUP_PAGE = 100

type TimelineRow =
  | { kind: 'single'; event: TimelineEvent }
  | { kind: 'group'; causeId: string; events: TimelineEvent[] }

const rowKey = (row: TimelineRow): string =>
  row.kind === 'single' ? `e${row.event.id}` : `g${row.causeId}`
const rowHas = (row: TimelineRow, key: string): boolean =>
  row.kind === 'single' ? `e${row.event.id}` === key : row.events.some((e) => `e${e.id}` === key)
const laneLabel = (lane: string): string => (lane === 'core' ? 'core' : lane.slice(7))

function TimelineView(props: {
  events: readonly TimelineEvent[]
  filter: string
  hidden: ReadonlySet<string>
  onToggleLane: (lane: string) => void
  dropped: number
  capacity: number
  focus: Focus | undefined
}): ReactElement {
  const { events, filter, hidden, focus } = props
  const lanes = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) {
      const lane = laneOf(e.event)
      m.set(lane, (m.get(lane) ?? 0) + 1)
    }
    return m
  }, [events])
  const visible = useMemo(
    () => (hidden.size === 0 ? events : events.filter((e) => !hidden.has(laneOf(e.event)))),
    [events, hidden],
  )
  const filtered = useFiltered(visible, filter, timelineHaystack)
  // Newest activity on top; within a cause-group the chain stays chronological
  // (top-to-bottom) so the cause → effect story reads in order.
  const rows = useMemo(() => groupByCause(filtered).reverse(), [filtered])
  const toggles = useToggles()
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(() => new Map())
  // A group's default open state is decided when the panel first sees it, so a
  // chain that grows past the threshold while you watch doesn't snap shut.
  const firstOpen = useRef(new Map<string, boolean>())
  const isOpen = (row: Extract<TimelineRow, { kind: 'group' }>): boolean => {
    let dflt = firstOpen.current.get(row.causeId)
    if (dflt === undefined) {
      dflt = row.events.length <= 12
      firstOpen.current.set(row.causeId, dflt)
    }
    return toggles.is(`g${row.causeId}`, dflt)
  }
  const limitOf = (causeId: string): number => limits.get(causeId) ?? GROUP_PAGE
  const focusIndex = focus === undefined ? -1 : rows.findIndex((r) => rowHas(r, focus.key))
  // A jump into a group opens it and pages far enough to mount the target.
  useEffect(() => {
    const row = rows[focusIndex]
    if (focus === undefined || row === undefined || row.kind !== 'group') return
    toggles.set(`g${row.causeId}`, true)
    const at = row.events.findIndex((e) => `e${e.id}` === focus.key)
    if (at >= limitOf(row.causeId)) setLimits((m) => new Map(m).set(row.causeId, at + 1))
  }, [focus?.nonce, focusIndex >= 0])

  const pluginLanes = lanes.size - (lanes.has('core') ? 1 : 0)
  const toolbar =
    pluginLanes > 0 || props.dropped > 0 ? (
      <div className="olas-devtools-tl-toolbar">
        {pluginLanes > 0 && (
          <div className="olas-devtools-lanes" role="group" aria-label="Lanes">
            {[...lanes].map(([lane, n]) => {
              const label = laneLabel(lane)
              const shown = !hidden.has(lane)
              return (
                <button
                  key={lane}
                  type="button"
                  className="olas-devtools-lane"
                  aria-pressed={shown}
                  title={`${shown ? 'Hide' : 'Show'} ${label} events`}
                  onClick={() => props.onToggleLane(lane)}
                >
                  {label} <span className="olas-devtools-lane-count">{n}</span>
                </button>
              )
            })}
          </div>
        )}
        {props.dropped > 0 && (
          <span
            className="olas-devtools-dropped"
            title={`The timeline keeps the newest ${props.capacity} events. Clear resets the count.`}
          >
            {props.dropped} older dropped
          </span>
        )}
      </div>
    ) : null

  let content: ReactElement
  if (events.length === 0) {
    content = (
      <Empty
        title="No events yet"
        hint="Interact with the app — mutations, fetches, cache writes and lifecycle events stream here, grouped by cause."
      />
    )
  } else if (rows.length === 0) {
    content =
      filter.trim() !== '' ? (
        <NoMatches filter={filter} />
      ) : (
        <Empty title="Every lane is hidden" hint="Show a lane above to see its events." />
      )
  } else {
    content = (
      <VirtualList
        count={rows.length}
        getKey={(i) => rowKey(rows[i] as TimelineRow)}
        estimate={(i) => {
          const row = rows[i] as TimelineRow
          if (row.kind === 'single') return 31
          if (!isOpen(row)) return 44
          const shown = Math.min(row.events.length, limitOf(row.causeId))
          return 44 + shown * 31 + (row.events.length > shown ? 30 : 0)
        }}
        renderRow={(i) => {
          const row = rows[i] as TimelineRow
          if (row.kind === 'single') {
            const key = `e${row.event.id}`
            return (
              <TimelineEventRow
                entry={row.event}
                expanded={toggles.is(key, false)}
                onToggle={() => toggles.toggle(key, false)}
                hit={focus?.key === key}
              />
            )
          }
          const open = isOpen(row)
          return (
            <CauseGroup
              events={row.events}
              open={open}
              onToggle={() => toggles.set(`g${row.causeId}`, !open)}
              limit={limitOf(row.causeId)}
              onMore={() =>
                setLimits((m) => new Map(m).set(row.causeId, limitOf(row.causeId) + GROUP_PAGE))
              }
              toggles={toggles}
              focusKey={focus?.key}
            />
          )
        }}
        label="Timeline"
        className="olas-devtools-timeline"
        pad={6}
        scrollToIndex={focusIndex}
        scrollNonce={focus?.nonce}
      />
    )
  }
  return (
    <>
      {toolbar}
      {content}
    </>
  )
}

/**
 * Fold the flat, seq-ordered event list into rows: events with a `causeId`
 * collapse into one group positioned at the group's FIRST event; un-caused
 * events stay standalone. The group array is filled by reference as later
 * events arrive, so a whole mutation chain renders together.
 */
function groupByCause(events: readonly TimelineEvent[]): TimelineRow[] {
  const groups = new Map<string, TimelineEvent[]>()
  const rows: TimelineRow[] = []
  for (const e of events) {
    if (e.causeId === undefined) {
      rows.push({ kind: 'single', event: e })
      continue
    }
    let g = groups.get(e.causeId)
    if (g === undefined) {
      g = []
      groups.set(e.causeId, g)
      rows.push({ kind: 'group', causeId: e.causeId, events: g })
    }
    g.push(e)
  }
  return rows
}

function timelineHaystack(e: TimelineEvent): string {
  const ev = e.event
  const parts: string[] = [ev.type, eventTarget(ev)]
  if (e.causeId !== undefined) parts.push(e.causeId)
  // `cache:set-data` carries its payload in `data` (not via `eventPayload`,
  // which returns undefined for it) — include source + data so the filter can
  // match a write by its content or by its source.
  if (ev.type === 'cache:set-data') parts.push(ev.source, toSearchText(ev.data))
  if (ev.type === 'plugin:event') parts.push(ev.plugin)
  const payload = eventPayload(ev)
  if (payload !== undefined) parts.push(toSearchText(payload))
  return parts.join(' ')
}

function CauseGroup(props: {
  events: TimelineEvent[]
  open: boolean
  onToggle: () => void
  limit: number
  onMore: () => void
  toggles: Toggles
  focusKey: string | undefined
}): ReactElement {
  const { events, open, limit, toggles } = props
  const start = (events[0] as TimelineEvent).t
  const rest = events.length - limit
  return (
    <div className={`olas-devtools-tl-group olas-devtools-tl-group-${groupStatus(events)}`}>
      <button
        type="button"
        className="olas-devtools-tl-group-head"
        aria-expanded={open}
        onClick={props.onToggle}
      >
        <span
          aria-hidden="true"
          className={`olas-devtools-chevron ${open ? 'olas-devtools-chevron-open' : ''}`}
        >
          ›
        </span>
        <span className="olas-devtools-tl-group-title">{groupHeadline(events)}</span>
        <span className="olas-devtools-tl-group-count">{events.length}</span>
        <span className="olas-devtools-time">{formatTime(start)}</span>
      </button>
      {open && (
        <div className="olas-devtools-tl-group-body">
          {events.slice(0, limit).map((e) => {
            const key = `e${e.id}`
            return (
              <TimelineEventRow
                key={e.id}
                entry={e}
                groupStart={start}
                expanded={toggles.is(key, false)}
                onToggle={() => toggles.toggle(key, false)}
                hit={props.focusKey === key}
              />
            )
          })}
          {rest > 0 && (
            <button type="button" className="olas-devtools-tl-more" onClick={props.onMore}>
              Show {Math.min(GROUP_PAGE, rest)} more of {rest}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** A group's title: the mutation it represents, else its first event. */
function groupHeadline(events: readonly TimelineEvent[]): string {
  const run = events.find((e) => e.event.type === 'mutation:run')
  if (run) return eventTarget(run.event)
  const first = (events[0] as TimelineEvent).event
  return `${badgeLabel(first)} · ${eventTarget(first)}`
}

/** Worst outcome seen in a group — drives the group's accent color. */
function groupStatus(events: readonly TimelineEvent[]): 'error' | 'rollback' | 'ok' | 'active' {
  const types = new Set(events.map((e) => e.event.type))
  if (types.has('mutation:error') || types.has('cache:fetch-error')) return 'error'
  if (types.has('mutation:rollback') || types.has('snapshot:rollback')) return 'rollback'
  if (types.has('mutation:success') || types.has('cache:fetch-success')) return 'ok'
  return 'active'
}

function TimelineEventRow(props: {
  entry: TimelineEvent
  groupStart?: number
  expanded: boolean
  onToggle: () => void
  hit: boolean
}): ReactElement {
  const { entry, groupStart, expanded, hit } = props
  const ev = entry.event
  const ref = useRef<HTMLDivElement>(null)
  // After the list has scrolled to the row's group, bring the event itself in.
  useEffect(() => {
    if (hit) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [hit])
  const isSetData = ev.type === 'cache:set-data'
  const payload = eventPayload(ev)
  const hasDetail = isSetData || payload !== undefined
  const delta = groupStart !== undefined ? entry.t - groupStart : undefined
  let cls = 'olas-devtools-tl-row'
  if (hasDetail) cls += ' olas-devtools-row-clickable'
  if (hit) cls += ' olas-devtools-hit'
  return (
    <div ref={ref} className={cls}>
      <div className="olas-devtools-tl-row-top" onClick={hasDetail ? props.onToggle : undefined}>
        <span className={`olas-devtools-kind ${timelineKindClass(ev.type)}`}>{badgeLabel(ev)}</span>
        <span className="olas-devtools-target">{eventTarget(ev)}</span>
        {delta !== undefined && delta > 0 && (
          <span className="olas-devtools-tl-delta">+{delta}ms</span>
        )}
        <span className="olas-devtools-time">{formatTime(entry.t)}</span>
        {hasDetail && (
          <span
            aria-hidden="true"
            className={`olas-devtools-chevron ${expanded ? 'olas-devtools-chevron-open' : ''}`}
          >
            ›
          </span>
        )}
      </div>
      {expanded && isSetData && (
        <div className="olas-devtools-payload olas-devtools-payload-json">
          <SetDataDetail entry={entry} />
        </div>
      )}
      {expanded && !isSetData && payload !== undefined && (
        <div className="olas-devtools-payload olas-devtools-payload-json">
          <JsonView value={payload} />
        </div>
      )}
    </div>
  )
}

/** The expanded body of a `cache:set-data` row — a structural before/after diff. */
function SetDataDetail({ entry }: { entry: TimelineEvent }): ReactElement {
  const ev = entry.event as Extract<DebugEvent, { type: 'cache:set-data' }>
  // `'prev' in entry` distinguishes "a baseline existed" (the store set `prev`,
  // possibly to `undefined`) from "first write to this key" (store left it
  // absent) — so a genuine `undefined → value` write renders as a diff, not as
  // an "initial" value.
  const hadBaseline = 'prev' in entry
  const diff = useMemo(() => diffValues(entry.prev, ev.data), [entry.prev, ev.data])
  return (
    <div>
      <div className="olas-devtools-tl-source">
        source: <strong>{ev.source}</strong>
      </div>
      {hadBaseline ? (
        <DiffView diff={diff} />
      ) : (
        // First write to the key — nothing to diff against; show the value.
        <JsonView value={ev.data} />
      )}
    </div>
  )
}

// ---- structural diff renderer ----

function DiffView({ diff }: { diff: Diff }): ReactElement {
  if (!hasChange(diff)) return <span className="olas-devtools-json-summary">no change</span>
  return <DiffNode diff={diff} />
}

function DiffNode({ diff }: { diff: Diff }): ReactElement {
  switch (diff.t) {
    case 'same':
      return <JsonView value={diff.value} />
    case 'add':
      return (
        <span className="olas-devtools-diff-add">
          <span className="olas-devtools-diff-mark">+</span>
          <JsonView value={diff.value} />
        </span>
      )
    case 'remove':
      return (
        <span className="olas-devtools-diff-remove">
          <span className="olas-devtools-diff-mark">−</span>
          <JsonView value={diff.value} />
        </span>
      )
    case 'change':
      return (
        <span className="olas-devtools-diff-change">
          <span className="olas-devtools-diff-prev">
            <JsonView value={diff.prev} />
          </span>
          <span className="olas-devtools-diff-arrow" aria-hidden="true">
            →
          </span>
          <span className="olas-devtools-diff-next">
            <JsonView value={diff.next} />
          </span>
        </span>
      )
    default: {
      // object | array — render only the changed entries, summarize the rest.
      const changed = diff.entries.filter((e) => e.diff.t !== 'same')
      const unchanged = diff.entries.length - changed.length
      const [open, close] = diff.t === 'array' ? ['[', ']'] : ['{', '}']
      return (
        <span className="olas-devtools-diff-block">
          <span className="olas-devtools-json-bracket">{open}</span>
          <span className="olas-devtools-diff-children">
            {changed.map((e) => (
              <span key={e.key} className="olas-devtools-diff-row">
                <span className="olas-devtools-json-key">{e.key}:</span>
                <DiffNode diff={e.diff} />
              </span>
            ))}
            {unchanged > 0 && (
              <span className="olas-devtools-diff-unchanged">+{unchanged} unchanged</span>
            )}
          </span>
          <span className="olas-devtools-json-bracket">{close}</span>
        </span>
      )
    }
  }
}

// ===========================================================================
// URL-hash persistence
// ===========================================================================

/**
 * Read the panel state from the hash. The hash comes from a URL anyone can
 * craft, so its shape is checked, not trusted (W15 security review, L7): an
 * unknown or non-string `tab` is ignored, a non-string filter is dropped,
 * and anything that is not a JSON object falls back to the defaults. A
 * non-string filter used to reach `filter.trim()` during render and unmount
 * the host app.
 */
function readUrlHash(
  key: string | undefined,
  defaultTab: DevtoolsTab,
): { tab: DevtoolsTab; filters: Record<DevtoolsTab, string> } {
  const filters = Object.fromEntries(TABS.map((t) => [t, ''])) as Record<DevtoolsTab, string>
  const fallback = { tab: defaultTab, filters }
  if (key === undefined || typeof window === 'undefined') return fallback
  let parsed: unknown
  try {
    const raw = new URLSearchParams(window.location.hash.replace(/^#/, '')).get(key)
    if (raw === null) return fallback
    parsed = JSON.parse(decodeURIComponent(raw))
  } catch {
    return fallback
  }
  if (!isRecord(parsed)) return fallback
  const stored = parsed.filters
  if (isRecord(stored)) {
    for (const t of TABS) {
      const v = Object.hasOwn(stored, t) ? stored[t] : undefined
      if (typeof v === 'string') filters[t] = v
    }
  }
  const tab = TABS.find((t) => t === parsed.tab) ?? defaultTab
  return { tab, filters }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function writeUrlHash(
  key: string,
  state: { tab: DevtoolsTab; filters: Record<DevtoolsTab, string> },
): void {
  if (typeof window === 'undefined') return
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  params.set(key, encodeURIComponent(JSON.stringify(state)))
  const next = `#${params.toString()}`
  if (next !== window.location.hash) {
    window.history.replaceState(null, '', next)
  }
}

// ===========================================================================
// Log lists — cache, inspector, mutations, fields — each windowed
// ===========================================================================

/** The shared shape of the four list views: filter, order, window, and lifted row state. */
function LogList<T extends object>(props: {
  items: readonly T[]
  filter: string
  haystack: (item: T) => string
  itemKey: (item: T) => string
  newestFirst: boolean
  empty: ReactElement
  label: string
  renderItem: (item: T, expanded: boolean, onToggle: () => void, hit: boolean) => ReactElement
  focus?: Focus | undefined
}): ReactElement {
  const { focus, itemKey } = props
  const filtered = useFiltered(props.items, props.filter, props.haystack)
  const rows = useMemo(
    () => (props.newestFirst ? filtered.slice().reverse() : filtered),
    [filtered, props.newestFirst],
  )
  const toggles = useToggles()
  if (props.items.length === 0) return props.empty
  if (rows.length === 0) return <NoMatches filter={props.filter} />
  const focusIndex = focus === undefined ? -1 : rows.findIndex((r) => itemKey(r) === focus.key)
  return (
    <VirtualList
      count={rows.length}
      getKey={(i) => itemKey(rows[i] as T)}
      estimate={() => 33}
      renderRow={(i) => {
        const item = rows[i] as T
        const key = itemKey(item)
        return props.renderItem(
          item,
          toggles.is(key, false),
          () => toggles.toggle(key, false),
          focus?.key === key,
        )
      }}
      as="ul"
      label={props.label}
      className="olas-devtools-list"
      scrollToIndex={focusIndex}
      scrollNonce={focus?.nonce}
    />
  )
}

const idKey = (e: { id: number }): string => String(e.id)

function InspectorView({
  entries,
  filter,
  focus,
}: {
  entries: DebugCacheEntry[]
  filter: string
  focus: Focus | undefined
}): ReactElement {
  return (
    <LogList
      items={entries}
      filter={filter}
      haystack={inspectorHaystack}
      itemKey={(e) => entryKey(e.queryId, e.key)}
      newestFirst={false}
      label="Cache entries"
      empty={
        <Empty
          title="No cache entries"
          hint="Subscribe to a query somewhere in the tree to see its data."
        />
      }
      focus={focus}
      renderItem={(entry, expanded, onToggle, hit) => (
        <InspectorRow entry={entry} expanded={expanded} onToggle={onToggle} hit={hit} />
      )}
    />
  )
}

function inspectorHaystack(e: DebugCacheEntry): string {
  return [...e.key.map(String), e.status, toSearchText(e.data)].join(' ')
}

function InspectorRow({
  entry,
  ...state
}: {
  entry: DebugCacheEntry
  expanded: boolean
  onToggle: () => void
  hit: boolean
}): ReactElement {
  const kindClass =
    entry.status === 'error'
      ? 'olas-devtools-kind-error'
      : entry.status === 'success'
        ? 'olas-devtools-kind-success'
        : entry.status === 'pending'
          ? 'olas-devtools-kind-warn'
          : ''
  const ageMs = entry.lastUpdatedAt != null ? Date.now() - entry.lastUpdatedAt : null
  const tags: string[] = []
  if (entry.isStale) tags.push('stale')
  if (entry.isFetching) tags.push('fetching')
  if (entry.hasPendingMutations) tags.push('optimistic')
  return (
    <Row
      {...state}
      kind={entry.status}
      kindClass={kindClass}
      target={formatPath(entry.key)}
      t={entry.lastUpdatedAt ?? Date.now()}
      payload={entry.error ?? entry.data}
      suffix={[ageMs != null ? `${formatAge(ageMs)} ago` : '—', ...tags].join(' · ')}
    />
  )
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function CacheView({ entries, filter }: { entries: CacheEntry[]; filter: string }): ReactElement {
  return (
    <LogList
      items={entries}
      filter={filter}
      haystack={cacheHaystack}
      itemKey={idKey}
      newestFirst
      label="Cache events"
      empty={
        <Empty
          title="No cache events yet"
          hint="Trigger a query subscription to see fetches here."
        />
      }
      renderItem={(entry, expanded, onToggle, hit) => (
        <CacheRow entry={entry} expanded={expanded} onToggle={onToggle} hit={hit} />
      )}
    />
  )
}

function cacheHaystack(e: CacheEntry): string {
  const parts: string[] = [e.kind, ...e.queryKey.map((p) => String(p))]
  if (e.kind === 'fetch-error') parts.push(toSearchText(e.error))
  if (e.kind === 'subscribed') parts.push(...e.subscriberPath)
  return parts.join(' ')
}

function CacheRow({
  entry,
  ...state
}: {
  entry: CacheEntry
  expanded: boolean
  onToggle: () => void
  hit: boolean
}): ReactElement {
  const kindClass =
    entry.kind === 'fetch-error'
      ? 'olas-devtools-kind-error'
      : entry.kind === 'fetch-success'
        ? 'olas-devtools-kind-success'
        : entry.kind === 'invalidated' || entry.kind === 'gc'
          ? 'olas-devtools-kind-warn'
          : ''

  let inline: string | null = null
  let payload: unknown | undefined
  let suffix: string | null = null
  if (entry.kind === 'fetch-success') {
    suffix = `${entry.durationMs}ms`
  } else if (entry.kind === 'fetch-error') {
    suffix = `${entry.durationMs}ms`
    payload = entry.error
  } else if (entry.kind === 'subscribed') {
    inline = `from ${formatPath(entry.subscriberPath)}`
  }

  return (
    <Row
      {...state}
      kind={entry.kind}
      kindClass={kindClass}
      target={formatPath(entry.queryKey)}
      t={entry.t}
      inline={inline}
      payload={payload}
      suffix={suffix}
    />
  )
}

function MutationsView({
  entries,
  filter,
}: {
  entries: MutationEntry[]
  filter: string
}): ReactElement {
  return (
    <LogList
      items={entries}
      filter={filter}
      haystack={mutationHaystack}
      itemKey={idKey}
      newestFirst
      label="Mutations"
      empty={
        <Empty title="No mutations yet" hint="Trigger a mutation to see the lifecycle here." />
      }
      renderItem={(entry, expanded, onToggle, hit) => (
        <MutationRow entry={entry} expanded={expanded} onToggle={onToggle} hit={hit} />
      )}
    />
  )
}

function mutationHaystack(e: MutationEntry): string {
  const parts: string[] = [e.kind, ...e.path, e.mutationId ?? '']
  if (e.kind === 'run') parts.push(toSearchText(e.vars))
  if (e.kind === 'success') parts.push(toSearchText(e.result))
  if (e.kind === 'error') parts.push(toSearchText(e.error))
  return parts.join(' ')
}

function MutationRow({
  entry,
  ...state
}: {
  entry: MutationEntry
  expanded: boolean
  onToggle: () => void
  hit: boolean
}): ReactElement {
  const kindClass =
    entry.kind === 'error'
      ? 'olas-devtools-kind-error'
      : entry.kind === 'rollback'
        ? 'olas-devtools-kind-rollback'
        : entry.kind === 'success'
          ? 'olas-devtools-kind-success'
          : ''

  const target = entry.mutationId
    ? `${entry.mutationId} · ${formatPath(entry.path)}`
    : formatPath(entry.path)

  let payload: unknown | undefined
  let suffix: string | null = null
  if (entry.kind === 'run') payload = entry.vars
  else if (entry.kind === 'success') {
    payload = entry.result
    if (entry.durationMs !== undefined) suffix = `${entry.durationMs}ms`
  } else if (entry.kind === 'error') {
    payload = entry.error
    if (entry.durationMs !== undefined) suffix = `${entry.durationMs}ms`
  }

  return (
    <Row
      {...state}
      kind={entry.kind}
      kindClass={kindClass}
      target={target}
      t={entry.t}
      payload={payload}
      suffix={suffix}
    />
  )
}

function FieldsView({ entries, filter }: { entries: FieldEntry[]; filter: string }): ReactElement {
  return (
    <LogList
      items={entries}
      filter={filter}
      haystack={fieldHaystack}
      itemKey={idKey}
      newestFirst
      label="Field validations"
      empty={
        <Empty
          title="No field validations yet"
          hint="Type into a form bound via createForm(ctx, ...) or createField(ctx, ...) — each pass lands here."
        />
      }
      renderItem={(entry, expanded, onToggle, hit) => (
        <FieldRow entry={entry} expanded={expanded} onToggle={onToggle} hit={hit} />
      )}
    />
  )
}

function fieldHaystack(e: FieldEntry): string {
  return [e.field, ...e.path, e.valid ? 'valid' : 'invalid', ...e.errors].join(' ')
}

function FieldRow({
  entry,
  ...state
}: {
  entry: FieldEntry
  expanded: boolean
  onToggle: () => void
  hit: boolean
}): ReactElement {
  const kindClass = entry.valid ? 'olas-devtools-kind-success' : 'olas-devtools-kind-error'
  return (
    <Row
      {...state}
      kind={entry.valid ? 'valid' : 'invalid'}
      kindClass={kindClass}
      target={`${formatPath(entry.path)} · ${entry.field}`}
      t={entry.t}
      inline={entry.errors.length > 0 ? entry.errors.join(' · ') : null}
    />
  )
}

// ===========================================================================
// Shared row + helpers
// ===========================================================================

type RowProps = {
  kind: string
  kindClass: string
  target: string
  t: number
  /** Either a tiny inline string (durations, urls) OR a structured payload. */
  inline?: string | null
  payload?: unknown
  suffix?: string | null
  expanded: boolean
  onToggle: () => void
  hit: boolean
}

function Row(props: RowProps): ReactElement {
  const { kind, kindClass, target, t, inline, payload, suffix, expanded, hit } = props
  const togglable = payload !== undefined
  let cls = togglable ? 'olas-devtools-row-clickable' : ''
  if (hit) cls = `${cls} olas-devtools-hit`.trim()
  return (
    <li className={cls}>
      <div className="olas-devtools-row-top" onClick={togglable ? props.onToggle : undefined}>
        <span className={`olas-devtools-kind ${kindClass}`}>{kind}</span>
        <span className="olas-devtools-target">{target}</span>
        {suffix !== undefined && suffix !== null && (
          <span className="olas-devtools-duration">{suffix}</span>
        )}
        <span className="olas-devtools-time">{formatTime(t)}</span>
        {togglable && (
          <span
            aria-hidden="true"
            className={`olas-devtools-chevron ${expanded ? 'olas-devtools-chevron-open' : ''}`}
          >
            ›
          </span>
        )}
      </div>
      {inline != null && (
        <div className="olas-devtools-payload olas-devtools-payload-inline">{inline}</div>
      )}
      {togglable && expanded && (
        <div className="olas-devtools-payload olas-devtools-payload-json">
          <JsonView value={payload} />
        </div>
      )}
    </li>
  )
}

/**
 * Search text per item, lowercased once. Log entries and timeline events are
 * immutable, so an item is turned into text the first time a filter runs over
 * it and never again: the debounced filter re-scans strings, it does not
 * re-stringify payloads.
 */
const hayCache = new WeakMap<object, string>()

function useFiltered<T extends object>(
  items: readonly T[],
  filter: string,
  haystack: (item: T) => string,
): readonly T[] {
  return useMemo(() => {
    if (filter.trim() === '') return items
    const q = filter.toLowerCase()
    return items.filter((item) => {
      let hay = hayCache.get(item)
      if (hay === undefined) {
        hay = haystack(item).toLowerCase()
        hayCache.set(item, hay)
      }
      return hay.includes(q)
    })
  }, [items, filter, haystack])
}

function NoMatches({ filter }: { filter: string }): ReactElement {
  return <Empty title="No matches" hint={`Nothing matches “${filter}”.`} />
}

function Empty({ title, hint }: { title: string; hint: string }): ReactElement {
  return (
    <div className="olas-devtools-empty">
      <div className="olas-devtools-empty-title">{title}</div>
      <div className="olas-devtools-empty-hint">{hint}</div>
    </div>
  )
}
