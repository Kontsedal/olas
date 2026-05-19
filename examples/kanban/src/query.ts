// Shared board query.
//
// Defined at module scope so every consumer that subscribes via
// `ctx.use(boardQuery, ...)` hits the same per-root cache entry. The fetcher
// receives `{ signal, deps }` from `FetchCtx`, so the api is reached via
// `deps.api` — no module-level capture, no `setApiForQuery(api)` ceremony.

import { defineQuery } from '@olas/core'
import type { Api, Board } from './api'

export const boardQuery = defineQuery({
  key: (id: string) => [id],
  fetcher: ({ signal, deps }, id: string): Promise<Board> => deps.api.getBoard(id, signal),
  staleTime: 10_000,
})

declare module '@olas/core' {
  interface AmbientDeps {
    api: Api
  }
}
