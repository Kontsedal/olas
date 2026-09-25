// One search box for the whole panel. `/` focuses it (the panel wires the
// key); the results come from the store's lazily built index, grouped by
// kind, and Enter jumps to the active result.

import { type ReactElement, type RefObject, useId, useMemo, useState } from 'react'
import type { SearchGroup, SearchHit, SearchKind } from './search'

const GROUP_TITLE: Record<SearchKind, string> = {
  controller: 'Controllers',
  query: 'Queries',
  mutation: 'Mutations',
  field: 'Fields',
  event: 'Payloads',
}

export function Omnibox(props: {
  search: (query: string) => SearchGroup[]
  onPick: (hit: SearchHit) => void
  /**
   * Changes whenever the store's data changes, so open results stay current.
   */
  rev: unknown
  inputRef: RefObject<HTMLInputElement | null>
}): ReactElement {
  const { search, onPick, rev, inputRef } = props
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const id = useId()
  const groups = useMemo(
    () => (open && query.trim() !== '' ? search(query) : []),
    [open, query, search, rev],
  )
  const hits = groups.flatMap((g) => g.hits)
  const current = Math.min(active, hits.length - 1)
  const pick = (hit: SearchHit): void => {
    setOpen(false)
    onPick(hit)
  }
  const showResults = open && query.trim() !== ''
  let n = -1
  return (
    <div className="olas-devtools-omnibox">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search everything"
        aria-expanded={showResults}
        aria-controls={`${id}-results`}
        aria-autocomplete="list"
        aria-activedescendant={showResults && current >= 0 ? `${id}-${current}` : undefined}
        placeholder="Search controllers, queries, mutations, fields, payloads"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setActive(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setActive(Math.max(0, Math.min(hits.length - 1, current + step)))
          } else if (e.key === 'Enter') {
            const hit = hits[current]
            if (hit !== undefined) pick(hit)
          } else if (e.key === 'Escape') {
            if (showResults) setOpen(false)
            else setQuery('')
          }
        }}
      />
      <span className="olas-devtools-kbd" aria-hidden="true">
        /
      </span>
      {showResults && (
        <div id={`${id}-results`} role="listbox" className="olas-devtools-omnibox-results">
          {groups.length === 0 && (
            <div className="olas-devtools-omnibox-empty">Nothing matches “{query}”.</div>
          )}
          {groups.map((g) => (
            <div key={g.kind} role="group" aria-labelledby={`${id}-${g.kind}`}>
              <div id={`${id}-${g.kind}`} className="olas-devtools-omnibox-group">
                {GROUP_TITLE[g.kind]}
                <span className="olas-devtools-omnibox-total">
                  {g.total > g.hits.length ? `${g.hits.length} of ${g.total}` : g.total}
                </span>
              </div>
              {g.hits.map((hit) => {
                n++
                const index = n
                return (
                  <div
                    key={`${hit.tab}:${hit.key}`}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={index === current}
                    className="olas-devtools-omnibox-hit"
                    // mousedown, not click: the input's blur would close the
                    // list before a click could land.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pick(hit)
                    }}
                    onMouseEnter={() => setActive(index)}
                  >
                    <span className="olas-devtools-omnibox-label">{hit.label}</span>
                    <span className="olas-devtools-omnibox-detail">{hit.detail}</span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
