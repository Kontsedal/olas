import { use, useRoot } from '@kontsedal/olas-react'
import { Loader2, Search, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { AppApi } from '../../app.controller'
import { IconButton, Kbd } from '../../ui'

export function SearchBar() {
  const app = useRoot<AppApi>()
  const value = use(app.board.searchInputRaw)
  const isSearching = use(app.board.isSearching)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="olas-search">
      <Search size={14} className="olas-search-icon" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => app.board.searchInputRaw.set(e.currentTarget.value)}
        placeholder="Search cards…"
        className="olas-search-input"
        aria-label="Search cards"
      />
      {isSearching && <Loader2 size={14} className="olas-spin olas-search-icon" />}
      {value !== '' && !isSearching && (
        <IconButton size="sm" label="Clear search" onClick={() => app.board.searchInputRaw.set('')}>
          <X size={12} />
        </IconButton>
      )}
      {value === '' && <Kbd>⌘K</Kbd>}
    </div>
  )
}
