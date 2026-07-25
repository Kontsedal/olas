// Compact JSON renderer for the devtools panel payload column.
//
// Renders values inline by default. Objects/arrays show their summary
// ("{4}", "[12]") inline; clicking the summary expands them. Each nested
// level inherits the same expand/collapse semantics. Scoped to the
// `olas-devtools-json-*` class prefix; styles are in `styles.ts`.

import { type ReactElement, useState } from 'react'

export function JsonView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactElement {
  // `seen` is the set of ANCESTORS on the current path, not "everything ever
  // rendered". It's rebuilt immutably at each level (a fresh copy per child),
  // so a SHARED reference (`{a: obj, b: obj}` — a DAG) is not mistaken for a
  // cycle, a collapse→re-expand doesn't carry stale state, and StrictMode's
  // double-render stays independent. A true cycle (a node that is its own
  // ancestor) is still caught. Root has no ancestors.
  return <Render value={value} depth={depth} initiallyOpen={depth === 0} seen={EMPTY_SEEN} />
}

const EMPTY_SEEN: ReadonlySet<object> = new Set()

function Render({
  value,
  depth,
  initiallyOpen,
  seen,
}: {
  value: unknown
  depth: number
  initiallyOpen: boolean
  seen: ReadonlySet<object>
}): ReactElement {
  if (value === null) return <span className="olas-devtools-json-null">null</span>
  if (value === undefined) return <span className="olas-devtools-json-null">undefined</span>

  const t = typeof value
  if (t === 'string') return <span className="olas-devtools-json-string">"{value as string}"</span>
  if (t === 'number') return <span className="olas-devtools-json-number">{String(value)}</span>
  if (t === 'boolean') return <span className="olas-devtools-json-boolean">{String(value)}</span>
  if (t === 'bigint') return <span className="olas-devtools-json-number">{String(value)}n</span>
  if (t === 'symbol') {
    return <span className="olas-devtools-json-summary">{String(value)}</span>
  }
  if (t === 'function') {
    const fn = value as { name?: string }
    return <span className="olas-devtools-json-summary">[fn{fn.name ? ` ${fn.name}` : ''}]</span>
  }

  // Errors render as `Error("message")` so they're distinguishable from
  // plain string payloads.
  if (value instanceof Error) {
    return (
      <span className="olas-devtools-json-error">
        {value.name}({JSON.stringify(value.message)})
      </span>
    )
  }

  // Cycle / circular reference guard — both arrays and plain objects can
  // re-enter themselves; without this guard the recursion stack-overflows
  // and takes the panel down (the WORST failure mode for a debugger). We flag
  // only ANCESTORS (a true cycle), never a merely repeated reference — see the
  // `seen` note in `JsonView`. The set is extended (immutably) below, only for
  // the branches that actually recurse.
  if (typeof value === 'object' && value !== null && seen.has(value as object)) {
    return <span className="olas-devtools-json-summary">[Circular]</span>
  }

  // Specialized renderers for built-ins that don't survive
  // `Object.keys` traversal: Map/Set carry data outside enumerable keys,
  // Date is a single scalar best shown as ISO, RegExp likewise, and
  // TypedArray would otherwise render as an opaque object.
  if (value instanceof Date) {
    return <span className="olas-devtools-json-string">{value.toISOString()}</span>
  }
  if (value instanceof RegExp) {
    return <span className="olas-devtools-json-string">{value.toString()}</span>
  }
  if (value instanceof Map) {
    return <span className="olas-devtools-json-summary">Map({value.size})</span>
  }
  if (value instanceof Set) {
    return <span className="olas-devtools-json-summary">Set({value.size})</span>
  }
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView & { length?: number }
    return (
      <span className="olas-devtools-json-summary">
        {value.constructor.name}({v.length ?? 0})
      </span>
    )
  }

  // Recursing branches extend the ancestor set with THIS node (a fresh copy,
  // so siblings and re-renders never accumulate each other's nodes).
  const childSeen: ReadonlySet<object> = new Set(seen).add(value as object)

  if (Array.isArray(value)) {
    return (
      <CollapsibleArray value={value} depth={depth} initiallyOpen={initiallyOpen} seen={childSeen} />
    )
  }

  if (t === 'object') {
    return (
      <CollapsibleObject
        value={value as Record<string, unknown>}
        depth={depth}
        initiallyOpen={initiallyOpen}
        seen={childSeen}
      />
    )
  }

  return <span>{String(value)}</span>
}

function CollapsibleArray({
  value,
  depth,
  initiallyOpen,
  seen,
}: {
  value: unknown[]
  depth: number
  initiallyOpen: boolean
  seen: ReadonlySet<object>
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen && value.length <= 12)
  if (value.length === 0) {
    return <span className="olas-devtools-json-bracket">[]</span>
  }
  if (!open) {
    return (
      <button type="button" className="olas-devtools-json-toggle" onClick={() => setOpen(true)}>
        <span className="olas-devtools-json-bracket">[</span>
        <span className="olas-devtools-json-summary">
          {value.length} item{value.length === 1 ? '' : 's'}
        </span>
        <span className="olas-devtools-json-bracket">]</span>
      </button>
    )
  }
  return (
    <span className="olas-devtools-json-block">
      <button
        type="button"
        className="olas-devtools-json-toggle olas-devtools-json-toggle-open"
        onClick={() => setOpen(false)}
      >
        <span className="olas-devtools-json-bracket">[</span>
      </button>
      <span className="olas-devtools-json-children">
        {value.map((item, idx) => (
          <span key={idx} className="olas-devtools-json-row">
            <span className="olas-devtools-json-index">{idx}:</span>
            <Render value={item} depth={depth + 1} initiallyOpen={false} seen={seen} />
          </span>
        ))}
      </span>
      <span className="olas-devtools-json-bracket">]</span>
    </span>
  )
}

function CollapsibleObject({
  value,
  depth,
  initiallyOpen,
  seen,
}: {
  value: Record<string, unknown>
  depth: number
  initiallyOpen: boolean
  seen: ReadonlySet<object>
}): ReactElement {
  const keys = Object.keys(value)
  const [open, setOpen] = useState(initiallyOpen && keys.length <= 8)
  if (keys.length === 0) {
    return <span className="olas-devtools-json-bracket">{'{}'}</span>
  }
  if (!open) {
    return (
      <button type="button" className="olas-devtools-json-toggle" onClick={() => setOpen(true)}>
        <span className="olas-devtools-json-bracket">{'{'}</span>
        <span className="olas-devtools-json-summary">
          {keys.slice(0, 3).join(', ')}
          {keys.length > 3 ? ` +${keys.length - 3}` : ''}
        </span>
        <span className="olas-devtools-json-bracket">{'}'}</span>
      </button>
    )
  }
  return (
    <span className="olas-devtools-json-block">
      <button
        type="button"
        className="olas-devtools-json-toggle olas-devtools-json-toggle-open"
        onClick={() => setOpen(false)}
      >
        <span className="olas-devtools-json-bracket">{'{'}</span>
      </button>
      <span className="olas-devtools-json-children">
        {keys.map((k) => (
          <span key={k} className="olas-devtools-json-row">
            <span className="olas-devtools-json-key">{k}:</span>
            <Render value={value[k]} depth={depth + 1} initiallyOpen={false} seen={seen} />
          </span>
        ))}
      </span>
      <span className="olas-devtools-json-bracket">{'}'}</span>
    </span>
  )
}
