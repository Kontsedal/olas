// Root composition. The only place that knows about *both* the api and the
// React tree — keeps the controller files free of bootstrap concerns.

import { createRoot, defineController } from '@olas/core'
import type { Api } from './api'
import { boardController } from './controllers/board'
import { setApiForQuery } from './query'

export function createAppRoot(api: Api, boardId: string) {
  setApiForQuery(api)
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
