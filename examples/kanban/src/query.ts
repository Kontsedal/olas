// Shared board query.
//
// Defined at module scope so every consumer that subscribes via
// `ctx.use(boardQuery, ...)` hits the same per-root cache entry. The fetcher
// pulls its api from the module-level `currentApi` that `createAppRoot`
// installs — the same pattern as `examples/user-profile`.
//
// A "real" app would prefer injecting the api through `ctx.deps` and avoid the
// module global, but keeping it module-scoped lets the query be defined here
// (top-level, importable) instead of inside the root factory.

import { defineQuery } from '@olas/core'
import type { Api, Board } from './api'

let currentApi: Api | undefined

export function setApiForQuery(api: Api): void {
  currentApi = api
}

export const boardQuery = defineQuery({
  key: (id: string) => [id],
  fetcher: async (id: string, signal: AbortSignal): Promise<Board> => {
    if (currentApi === undefined) {
      throw new Error('boardQuery: api not wired; call setApiForQuery first')
    }
    return currentApi.getBoard(id, signal)
  },
  staleTime: 10_000,
})

// Module augmentation lives next to its single consumer.
declare module '@olas/core' {
  interface AmbientDeps {
    api: Api
  }
}
