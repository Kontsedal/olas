import type { Root } from '@olas/core'
import { use } from '@olas/react'
import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { formatPath, formatPayload, formatTime } from './format'
import {
  type CacheEntry,
  type ControllerNode,
  DevtoolsStore,
  type FieldEntry,
  type MutationEntry,
} from './store'
import { DEVTOOLS_CSS } from './styles'

export type DevtoolsTab = 'tree' | 'cache' | 'mutations' | 'fields'

export type DevtoolsPanelProps = {
  /** The root to inspect. The panel subscribes to `root.__debug` on mount. */
  root: Pick<Root<unknown>, '__debug'>
  /** Initial tab. Default: `'tree'`. */
  defaultTab?: DevtoolsTab
  /** Cap on each event log. Default: 100. */
  maxEntries?: number
}

/**
 * Drop-in devtools panel for an Olas root. Subscribes to `root.__debug` and
 * renders four tabs: controller Tree, cache Timeline, Mutations, and Field
 * validations. Styled inline (no CSS import needed) and scoped to the
 * `.olas-devtools-*` class prefix.
 *
 * The panel is itself a React component, so it must live inside a React tree
 * — but it does NOT need to be wrapped in `<OlasProvider>`; the root is
 * passed via prop. Spec §13.
 */
export function DevtoolsPanel(props: DevtoolsPanelProps): ReactElement {
  const { root, defaultTab = 'tree', maxEntries } = props
  const store = useMemo(
    () => new DevtoolsStore(maxEntries !== undefined ? { maxEntries } : undefined),
    [maxEntries],
  )
  useEffect(() => store.attach(root), [root, store])

  const [tab, setTab] = useState<DevtoolsTab>(defaultTab)

  return (
    <div className="olas-devtools" data-testid="olas-devtools">
      <style>{DEVTOOLS_CSS}</style>
      <div className="olas-devtools-tabs" role="tablist">
        <Tab name="tree" current={tab} setTab={setTab} label="Tree" />
        <Tab name="cache" current={tab} setTab={setTab} label="Cache" />
        <Tab name="mutations" current={tab} setTab={setTab} label="Mutations" />
        <Tab name="fields" current={tab} setTab={setTab} label="Fields" />
        <button className="olas-devtools-clear" type="button" onClick={() => store.clearLogs()}>
          Clear
        </button>
      </div>
      <div className="olas-devtools-body" role="tabpanel">
        {tab === 'tree' && <TreeView store={store} />}
        {tab === 'cache' && <CacheView store={store} />}
        {tab === 'mutations' && <MutationsView store={store} />}
        {tab === 'fields' && <FieldsView store={store} />}
      </div>
    </div>
  )
}

function Tab(props: {
  name: DevtoolsTab
  current: DevtoolsTab
  setTab: (t: DevtoolsTab) => void
  label: string
}): ReactElement {
  const selected = props.current === props.name
  return (
    <button
      role="tab"
      type="button"
      aria-selected={selected}
      className="olas-devtools-tab"
      onClick={() => props.setTab(props.name)}
    >
      {props.label}
    </button>
  )
}

function TreeView({ store }: { store: DevtoolsStore }): ReactElement {
  const tree = use(store.tree$)
  if (tree.children.length === 0) {
    return <div className="olas-devtools-empty">No controllers constructed yet.</div>
  }
  return (
    <div className="olas-devtools-tree">
      {tree.children.map((child) => (
        <TreeNode key={child.path.join('/')} node={child} />
      ))}
    </div>
  )
}

function TreeNode({ node }: { node: ControllerNode }): ReactElement {
  const name = node.path[node.path.length - 1] ?? '?'
  const stateClass =
    node.state === 'active'
      ? ''
      : node.state === 'suspended'
        ? 'olas-devtools-tree-state-suspended'
        : 'olas-devtools-tree-state-disposed'
  return (
    <div className="olas-devtools-tree-node">
      <span className={`olas-devtools-tree-name ${stateClass}`}>
        {name} <span className="olas-devtools-time">({node.state})</span>
      </span>
      {node.children.length > 0 && (
        <div className="olas-devtools-tree-children">
          {node.children.map((child) => (
            <TreeNode key={child.path.join('/')} node={child} />
          ))}
        </div>
      )}
    </div>
  )
}

function CacheView({ store }: { store: DevtoolsStore }): ReactElement {
  const entries = use(store.cache$)
  if (entries.length === 0) {
    return <div className="olas-devtools-empty">No cache events yet.</div>
  }
  return (
    <ul className="olas-devtools-list">
      {entries.map((entry) => (
        <CacheRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

function CacheRow({ entry }: { entry: CacheEntry }): ReactElement {
  const kindClass = entry.kind === 'fetch-error' ? 'olas-devtools-kind-error' : ''
  return (
    <li>
      <span className="olas-devtools-time">{formatTime(entry.t)}</span>
      <span className={`olas-devtools-kind ${kindClass}`}>{entry.kind}</span>
      <span className="olas-devtools-payload">
        {formatPath(entry.queryKey)}
        {entry.kind === 'fetch-success' || entry.kind === 'fetch-error'
          ? ` · ${entry.durationMs}ms`
          : ''}
        {entry.kind === 'fetch-error' ? ` · ${formatPayload(entry.error, 80)}` : ''}
        {entry.kind === 'subscribed' ? ` · ${formatPath(entry.subscriberPath)}` : ''}
      </span>
    </li>
  )
}

function MutationsView({ store }: { store: DevtoolsStore }): ReactElement {
  const entries = use(store.mutations$)
  if (entries.length === 0) {
    return <div className="olas-devtools-empty">No mutations yet.</div>
  }
  return (
    <ul className="olas-devtools-list">
      {entries.map((entry) => (
        <MutationRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

function MutationRow({ entry }: { entry: MutationEntry }): ReactElement {
  const kindClass =
    entry.kind === 'error'
      ? 'olas-devtools-kind-error'
      : entry.kind === 'rollback'
        ? 'olas-devtools-kind-rollback'
        : ''
  return (
    <li>
      <span className="olas-devtools-time">{formatTime(entry.t)}</span>
      <span className={`olas-devtools-kind ${kindClass}`}>{entry.kind}</span>
      <span className="olas-devtools-payload">
        {formatPath(entry.path)}
        {entry.kind === 'run' ? ` · ${formatPayload(entry.vars, 80)}` : ''}
        {entry.kind === 'success' ? ` · ${formatPayload(entry.result, 80)}` : ''}
        {entry.kind === 'error' ? ` · ${formatPayload(entry.error, 80)}` : ''}
      </span>
    </li>
  )
}

function FieldsView({ store }: { store: DevtoolsStore }): ReactElement {
  const entries = use(store.fields$)
  if (entries.length === 0) {
    return <div className="olas-devtools-empty">No field validations yet.</div>
  }
  return (
    <ul className="olas-devtools-list">
      {entries.map((entry) => (
        <FieldRow key={entry.id} entry={entry} />
      ))}
    </ul>
  )
}

function FieldRow({ entry }: { entry: FieldEntry }): ReactElement {
  const kindClass = entry.valid ? '' : 'olas-devtools-kind-error'
  return (
    <li>
      <span className="olas-devtools-time">{formatTime(entry.t)}</span>
      <span className={`olas-devtools-kind ${kindClass}`}>{entry.valid ? 'valid' : 'invalid'}</span>
      <span className="olas-devtools-payload">
        {formatPath(entry.path)} · {entry.field}
        {entry.errors.length > 0 ? ` · ${entry.errors.join(', ')}` : ''}
      </span>
    </li>
  )
}
