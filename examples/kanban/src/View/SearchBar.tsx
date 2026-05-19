// Search bar — demonstrates LATEST-WINS by typing rapidly.

import { use } from '@kontsedal/olas-react'
import { Loader2, Search } from 'lucide-react'
import { type ReactElement, useEffect, useState } from 'react'
import { useApi } from './useApi'

export function SearchBar(): ReactElement {
  const api = useApi()
  const isPending = use(api.board.applyFilter.isPending)
  const results = use(api.board.filterResults)
  const [q, setQ] = useState('')

  // Latest-wins handles concurrent requests for us — the prior in-flight
  // call's abort signal fires when a new one starts. Rejections from
  // superseded runs are expected; swallow them.
  useEffect(() => {
    api.board.applyFilter.run({ q }).catch(() => {})
  }, [q, api])

  return (
    <div className="flex items-center gap-3 rounded-xl border border-(--color-border) bg-(--color-bg-elev) px-3 py-2 shadow-[var(--shadow-card)]">
      <Search className="size-4 text-(--color-fg-mute)" />
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search cards — latest-wins concurrency mode"
        className="flex-1 bg-transparent outline-none text-sm placeholder:text-(--color-fg-mute)"
      />
      <span className="text-xs text-(--color-fg-mute) whitespace-nowrap inline-flex items-center gap-1.5">
        {isPending ? (
          <>
            <Loader2 className="size-3 animate-spin" /> searching…
          </>
        ) : results ? (
          <>
            {results.matches.length} match{results.matches.length === 1 ? '' : 'es'}
            {results.query && <span className="text-(--color-fg)"> “{results.query}”</span>}
          </>
        ) : (
          'idle'
        )}
      </span>
    </div>
  )
}
