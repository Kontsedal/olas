import type { DebugCacheEntry, Root } from '@kontsedal/olas-core'
import { use } from '@kontsedal/olas-react'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { formatPath, formatTime } from './format'
import { JsonView } from './JsonView'
import {
  type CacheEntry,
  type ControllerNode,
  DevtoolsStore,
  type FieldEntry,
  type MutationEntry,
} from './store'
import { DEVTOOLS_CSS } from './styles'

export type DevtoolsTab = 'tree' | 'cache' | 'inspector' | 'mutations' | 'fields'

export type DevtoolsPanelProps = {
  /** The root to inspect. The panel subscribes to `root.__debug` on mount. */
  root: Pick<Root<unknown>, '__debug'>
  /** Initial tab. Default: `'tree'`. */
  defaultTab?: DevtoolsTab
  /** Cap on each event log. Default: 100. */
  maxEntries?: number
  /**
   * Persist filter state to the URL hash under this key. When set,
   * reloading the page restores filter + tab. Default: no persistence.
   */
  urlHashKey?: string
  /** How often (ms) to refresh the live cache inspector snapshot. Default 800. */
  inspectorPollMs?: number
}

/**
 * Drop-in devtools panel for an Olas root.
 *
 * Features:
 *  - **Tree** populated from the snapshot replay on mount (no lost events).
 *  - **Cache / Mutations / Fields** event logs in reverse chronological order.
 *  - **Filter** field per tab — text-matches kind, path, name, payload.
 *  - **Pause** toggle freezes the log without stopping ingestion.
 *  - **Click a row** to expand its payload from a truncated preview to the full
 *    JSON.
 *  - **Mutation durations** — `run → success/error` pairing surfaces elapsed ms.
 *
 * Styled inline (no CSS import needed) and scoped to the `.olas-devtools-*`
 * class prefix. Hosts override the palette via `--olas-*` custom properties.
 * Spec §13.
 */
export function DevtoolsPanel(props: DevtoolsPanelProps): ReactElement {
  const { root, defaultTab = 'tree', maxEntries, urlHashKey, inspectorPollMs = 800 } = props
  const store = useMemo(
    () => new DevtoolsStore(maxEntries !== undefined ? { maxEntries } : undefined),
    [maxEntries],
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

  // Persist tab + filters back to the URL hash on every change.
  useEffect(() => {
    if (urlHashKey === undefined) return
    writeUrlHash(urlHashKey, { tab, filters })
  }, [urlHashKey, tab, filters])

  // Live cache inspector — polls `root.__debug.queryEntries()` periodically.
  // Polling is cheap (a single peek per entry) and bounded by inspectorPollMs;
  // only the Cache Inspector view reads this.
  const [cacheEntries, setCacheEntries] = useState<DebugCacheEntry[]>([])
  const rootRef = useRef(root)
  rootRef.current = root
  useEffect(() => {
    if (tab !== 'inspector') return
    const tick = () => setCacheEntries(rootRef.current.__debug.queryEntries())
    tick()
    const id = window.setInterval(tick, inspectorPollMs)
    return () => window.clearInterval(id)
  }, [tab, inspectorPollMs])

  const liveTree = use(store.tree$)
  const liveCache = use(store.cache$)
  const liveMutations = use(store.mutations$)
  const liveFields = use(store.fields$)

  // When paused, snapshot once and keep showing that frozen state.
  const [frozen, setFrozen] = useState<{
    tree: ControllerNode
    cache: CacheEntry[]
    mutations: MutationEntry[]
    fields: FieldEntry[]
  } | null>(null)
  useEffect(() => {
    if (paused) {
      setFrozen({
        tree: liveTree,
        cache: liveCache,
        mutations: liveMutations,
        fields: liveFields,
      })
    } else {
      setFrozen(null)
    }
    // We only re-snapshot when the toggle flips, not on every event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])

  const tree = frozen?.tree ?? liveTree
  const cache = frozen?.cache ?? liveCache
  const mutations = frozen?.mutations ?? liveMutations
  const fields = frozen?.fields ?? liveFields

  return (
    <div className="olas-devtools" data-testid="olas-devtools">
      <style>{DEVTOOLS_CSS}</style>
      <div className="olas-devtools-tabs" role="tablist">
        <Tab
          name="tree"
          current={tab}
          setTab={setTab}
          label="Tree"
          short="Tree"
          count={countLiveControllers(liveTree)}
        />
        <Tab
          name="cache"
          current={tab}
          setTab={setTab}
          label="Cache"
          short="Cache"
          count={liveCache.length}
        />
        <Tab
          name="inspector"
          current={tab}
          setTab={setTab}
          label="Inspector"
          short="Insp"
          count={cacheEntries.length}
        />
        <Tab
          name="mutations"
          current={tab}
          setTab={setTab}
          label="Mutations"
          short="Mut"
          count={liveMutations.length}
        />
        <Tab
          name="fields"
          current={tab}
          setTab={setTab}
          label="Fields"
          short="Fld"
          count={liveFields.length}
        />
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

      {(tab === 'cache' || tab === 'inspector' || tab === 'mutations' || tab === 'fields') && (
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
        {tab === 'tree' && <TreeView tree={tree} mutations={liveMutations} />}
        {tab === 'cache' && <CacheView entries={cache} filter={filter} />}
        {tab === 'inspector' && <InspectorView entries={cacheEntries} filter={filter} />}
        {tab === 'mutations' && <MutationsView entries={mutations} filter={filter} />}
        {tab === 'fields' && <FieldsView entries={fields} filter={filter} />}
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

function countLiveControllers(node: ControllerNode): number {
  let total = node.state !== 'disposed' ? 1 : 0
  for (const c of node.children) total += countLiveControllers(c)
  return Math.max(total - 1, 0) // exclude the placeholder root wrapper
}

// ===========================================================================
// Tree
// ===========================================================================

function TreeView({
  tree,
  mutations,
}: {
  tree: ControllerNode
  mutations: MutationEntry[]
}): ReactElement {
  // Roll up pending-mutation counts per controller path. A "pending" mutation
  // is one whose last entry is `run` with no matching success/error for the
  // same (path, name). Computed unconditionally — must run before any early
  // return so hook-order is stable across renders (rules of hooks).
  const pending = useMemo(() => rollupPending(mutations), [mutations])
  if (tree.children.length === 0) {
    return <Empty title="No controllers yet" hint="The root hasn't constructed any controllers." />
  }
  return (
    <div className="olas-devtools-tree">
      {tree.children.map((child) => (
        <TreeNode key={child.path.join('/')} node={child} pending={pending} />
      ))}
    </div>
  )
}

function rollupPending(entries: readonly MutationEntry[]): Map<string, number> {
  const inFlight = new Map<string, number>() // (path|name) → count
  const out = new Map<string, number>() // path → pending count
  for (const e of entries) {
    const key = `${e.path.join('>')}#${e.name ?? ''}`
    const pathKey = e.path.join('>')
    if (e.kind === 'run') {
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1)
      out.set(pathKey, (out.get(pathKey) ?? 0) + 1)
    } else if (e.kind === 'success' || e.kind === 'error') {
      const n = inFlight.get(key) ?? 0
      if (n > 0) inFlight.set(key, n - 1)
      const p = out.get(pathKey) ?? 0
      if (p > 0) out.set(pathKey, p - 1)
    }
  }
  return out
}

function TreeNode({
  node,
  pending,
}: {
  node: ControllerNode
  pending: Map<string, number>
}): ReactElement {
  const name = node.path[node.path.length - 1] ?? '?'
  const stateClass =
    node.state === 'suspended'
      ? 'olas-devtools-tree-state-suspended'
      : node.state === 'disposed'
        ? 'olas-devtools-tree-state-disposed'
        : 'olas-devtools-tree-state-active'
  const pendingCount = pending.get(node.path.join('>')) ?? 0
  const propsPreview = useMemo(() => summarizeProps(node.props), [node.props])
  const [propsOpen, setPropsOpen] = useState(false)
  const canExpandProps = node.props !== undefined && node.props !== null

  return (
    <div className="olas-devtools-tree-node">
      <span className="olas-devtools-tree-row">
        <span className="olas-devtools-tree-name">{name}</span>
        <span className={stateClass}>{node.state}</span>
        {pendingCount > 0 && (
          <span className="olas-devtools-tree-pending" title="pending mutations on this controller">
            {pendingCount} pending
          </span>
        )}
        {canExpandProps && (
          <button
            type="button"
            className="olas-devtools-tree-props-toggle"
            aria-expanded={propsOpen}
            onClick={() => setPropsOpen((v) => !v)}
            title={propsOpen ? 'Hide props' : 'Show full props'}
          >
            {propsPreview}
          </button>
        )}
      </span>
      {propsOpen && canExpandProps && (
        <div className="olas-devtools-tree-props">
          <JsonView value={node.props} />
        </div>
      )}
      {node.children.length > 0 && (
        <div className="olas-devtools-tree-children">
          {node.children.map((child) => (
            <TreeNode key={child.path.join('/')} node={child} pending={pending} />
          ))}
        </div>
      )}
    </div>
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
// Cache Inspector — live state, not history
// ===========================================================================

function InspectorView({
  entries,
  filter,
}: {
  entries: DebugCacheEntry[]
  filter: string
}): ReactElement {
  const filtered = useFiltered(entries, filter, inspectorHaystack)
  if (entries.length === 0) {
    return (
      <Empty
        title="No cache entries"
        hint="Subscribe to a query somewhere in the tree to see its data."
      />
    )
  }
  if (filtered.length === 0) {
    return <Empty title="No matches" hint={`Nothing matches “${filter}”.`} />
  }
  return (
    <ul className="olas-devtools-list">
      {filtered.map((entry) => (
        <InspectorRow key={entry.key.join('|')} entry={entry} />
      ))}
    </ul>
  )
}

function inspectorHaystack(e: DebugCacheEntry): string {
  return [...e.key.map(String), e.status, safeStringify(e.data)].join(' ')
}

function InspectorRow({ entry }: { entry: DebugCacheEntry }): ReactElement {
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
      kind={entry.status}
      kindClass={kindClass}
      target={formatPath(entry.key)}
      t={entry.lastUpdatedAt ?? Date.now()}
      payload={entry.error ?? entry.data}
      suffix={[ageMs != null ? `${formatAge(ageMs)} ago` : '—', ...tags].join(' · ')}
    />
  )
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

// ===========================================================================
// URL-hash persistence
// ===========================================================================

function readUrlHash(
  key: string | undefined,
  defaultTab: DevtoolsTab,
): { tab: DevtoolsTab; filters: Record<DevtoolsTab, string> } {
  const empty = { tree: '', cache: '', inspector: '', mutations: '', fields: '' }
  if (key === undefined) return { tab: defaultTab, filters: empty }
  if (typeof window === 'undefined') return { tab: defaultTab, filters: empty }
  try {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const raw = params.get(key)
    if (raw === null) return { tab: defaultTab, filters: empty }
    const parsed = JSON.parse(decodeURIComponent(raw)) as {
      tab?: DevtoolsTab
      filters?: Partial<Record<DevtoolsTab, string>>
    }
    return {
      tab: parsed.tab ?? defaultTab,
      filters: { ...empty, ...(parsed.filters ?? {}) },
    }
  } catch {
    return { tab: defaultTab, filters: empty }
  }
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
// Cache
// ===========================================================================

function CacheView({ entries, filter }: { entries: CacheEntry[]; filter: string }): ReactElement {
  const filtered = useFiltered(entries, filter, cacheHaystack)
  if (entries.length === 0) {
    return (
      <Empty title="No cache events yet" hint="Trigger a query subscription to see fetches here." />
    )
  }
  if (filtered.length === 0) {
    return <Empty title="No matches" hint={`Nothing matches “${filter}”.`} />
  }
  return (
    <ul className="olas-devtools-list">
      {[...filtered].reverse().map((entry) => (
        <CacheRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

function cacheHaystack(e: CacheEntry): string {
  const parts: string[] = [e.kind, ...e.queryKey.map((p) => String(p))]
  if (e.kind === 'fetch-error') parts.push(safeStringify(e.error))
  if (e.kind === 'subscribed') parts.push(...e.subscriberPath)
  return parts.join(' ')
}

function CacheRow({ entry }: { entry: CacheEntry }): ReactElement {
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

// ===========================================================================
// Mutations
// ===========================================================================

function MutationsView({
  entries,
  filter,
}: {
  entries: MutationEntry[]
  filter: string
}): ReactElement {
  const filtered = useFiltered(entries, filter, mutationHaystack)
  if (entries.length === 0) {
    return <Empty title="No mutations yet" hint="Trigger a mutation to see the lifecycle here." />
  }
  if (filtered.length === 0) {
    return <Empty title="No matches" hint={`Nothing matches “${filter}”.`} />
  }
  return (
    <ul className="olas-devtools-list">
      {[...filtered].reverse().map((entry) => (
        <MutationRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

function mutationHaystack(e: MutationEntry): string {
  const parts: string[] = [e.kind, ...e.path, e.name ?? '']
  if (e.kind === 'run') parts.push(safeStringify(e.vars))
  if (e.kind === 'success') parts.push(safeStringify(e.result))
  if (e.kind === 'error') parts.push(safeStringify(e.error))
  return parts.join(' ')
}

function MutationRow({ entry }: { entry: MutationEntry }): ReactElement {
  const kindClass =
    entry.kind === 'error'
      ? 'olas-devtools-kind-error'
      : entry.kind === 'rollback'
        ? 'olas-devtools-kind-rollback'
        : entry.kind === 'success'
          ? 'olas-devtools-kind-success'
          : ''

  const target = entry.name ? `${entry.name} · ${formatPath(entry.path)}` : formatPath(entry.path)

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
      kind={entry.kind}
      kindClass={kindClass}
      target={target}
      t={entry.t}
      payload={payload}
      suffix={suffix}
    />
  )
}

// ===========================================================================
// Fields
// ===========================================================================

function FieldsView({ entries, filter }: { entries: FieldEntry[]; filter: string }): ReactElement {
  const filtered = useFiltered(entries, filter, fieldHaystack)
  if (entries.length === 0) {
    return (
      <Empty
        title="No field validations yet"
        hint="Type into a form bound via ctx.form(...) or ctx.field(...) — each pass lands here."
      />
    )
  }
  if (filtered.length === 0) {
    return <Empty title="No matches" hint={`Nothing matches “${filter}”.`} />
  }
  return (
    <ul className="olas-devtools-list">
      {[...filtered].reverse().map((entry) => (
        <FieldRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

function fieldHaystack(e: FieldEntry): string {
  return [e.field, ...e.path, e.valid ? 'valid' : 'invalid', ...e.errors].join(' ')
}

function FieldRow({ entry }: { entry: FieldEntry }): ReactElement {
  const kindClass = entry.valid ? 'olas-devtools-kind-success' : 'olas-devtools-kind-error'
  return (
    <Row
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
}

function Row(props: RowProps): ReactElement {
  const { kind, kindClass, target, t, inline, payload, suffix } = props
  const hasPayload = payload !== undefined
  const [expanded, setExpanded] = useState(false)
  const togglable = hasPayload

  return (
    <li className={togglable ? 'olas-devtools-row-clickable' : ''}>
      <div
        className="olas-devtools-row-top"
        onClick={togglable ? () => setExpanded((v) => !v) : undefined}
      >
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
      {hasPayload && expanded && (
        <div className="olas-devtools-payload olas-devtools-payload-json">
          <JsonView value={payload} />
        </div>
      )}
    </li>
  )
}

function useFiltered<T>(items: readonly T[], filter: string, haystack: (item: T) => string): T[] {
  return useMemo(() => {
    if (filter.trim() === '') return [...items]
    const q = filter.toLowerCase()
    return items.filter((item) => haystack(item).toLowerCase().includes(q))
  }, [items, filter, haystack])
}

function Empty({ title, hint }: { title: string; hint: string }): ReactElement {
  return (
    <div className="olas-devtools-empty">
      <div className="olas-devtools-empty-title">{title}</div>
      <div className="olas-devtools-empty-hint">{hint}</div>
    </div>
  )
}
