import { defineQuery } from '@kontsedal/olas-core'
import type { Board } from '../../api'

/**
 * Board query — keyed by board id. `crossTab: true` propagates optimistic
 * patches across browser tabs through `crossTabPlugin`. The fetcher pulls
 * `api` off `ctx.deps`; per-tab fetches still run independently.
 */
export const boardQuery = defineQuery({
  queryId: 'board',
  crossTab: true,
  key: (id: string) => [id],
  fetcher: ({ signal, deps }, id: string): Promise<Board> => deps.api.getBoard(id, signal),
  staleTime: 10_000,
})
