// Root composition. The only place that knows about *both* the api and the
// React tree — keeps the controller files free of bootstrap concerns.
//
// `boardQuery`'s fetcher pulls `api` from `ctx.deps`, so handing the api into
// `createRoot({ deps })` is all the wiring needed — no module-level state.

import { createRoot, defineController } from '@kontsedal/olas-core'
import type { Api } from './api'
import { boardController } from './controllers/board'

export function createAppRoot(api: Api, boardId: string) {
  const appController = defineController(
    (ctx) => ({
      board: ctx.child(boardController, { boardId }),
    }),
    { name: 'app' },
  )
  return createRoot(appController, { deps: { api } })
}

export type AppRoot = ReturnType<typeof createAppRoot>

/** The controller-tree api surface visible inside React (no Root lifecycle). */
export type AppApi = Omit<
  AppRoot,
  'dispose' | 'suspend' | 'resume' | 'dehydrate' | 'waitForIdle' | '__debug'
>
