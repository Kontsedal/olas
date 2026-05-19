// Compact JSON renderer for the devtools panel payload column.
//
// Renders values inline by default. Objects/arrays show their summary
// ("{4}", "[12]") inline; clicking the summary expands them. Each nested
// level inherits the same expand/collapse semantics. Scoped to the
// `olas-devtools-json-*` class prefix; styles are in `styles.ts`.

import { type ReactElement, useState } from 'react'

export function JsonView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactElement {
  return <Render value={value} depth={depth} initiallyOpen={depth === 0} />
}

function Render({
  value,
  depth,
  initiallyOpen,
}: {
  value: unknown
  depth: number
  initiallyOpen: boolean
}): ReactElement {
  if (value === null) return <span className="olas-devtools-json-null">null</span>
  if (value === undefined) return <span className="olas-devtools-json-null">undefined</span>

  const t = typeof value
  if (t === 'string') return <span className="olas-devtools-json-string">"{value as string}"</span>
  if (t === 'number') return <span className="olas-devtools-json-number">{String(value)}</span>
  if (t === 'boolean') return <span className="olas-devtools-json-boolean">{String(value)}</span>
  if (t === 'bigint') return <span className="olas-devtools-json-number">{String(value)}n</span>

  // Errors render as `Error("message")` so they're distinguishable from
  // plain string payloads.
  if (value instanceof Error) {
    return (
      <span className="olas-devtools-json-error">
        {value.name}({JSON.stringify(value.message)})
      </span>
    )
  }

  if (Array.isArray(value)) {
    return <CollapsibleArray value={value} depth={depth} initiallyOpen={initiallyOpen} />
  }

  if (t === 'object') {
    return (
      <CollapsibleObject
        value={value as Record<string, unknown>}
        depth={depth}
        initiallyOpen={initiallyOpen}
      />
    )
  }

  return <span>{String(value)}</span>
}

function CollapsibleArray({
  value,
  depth,
  initiallyOpen,
}: {
  value: unknown[]
  depth: number
  initiallyOpen: boolean
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
            <Render value={item} depth={depth + 1} initiallyOpen={false} />
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
}: {
  value: Record<string, unknown>
  depth: number
  initiallyOpen: boolean
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
            <Render value={value[k]} depth={depth + 1} initiallyOpen={false} />
          </span>
        ))}
      </span>
      <span className="olas-devtools-json-bracket">{'}'}</span>
    </span>
  )
}
