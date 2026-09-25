// Root composition for the virtualized-table example.

import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import type { Api } from './api'
import { tableController } from './controllers/table'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: Api
  }
}

export function createAppRoot(api: Api, rowCount: number) {
  const appController = defineController(
    (ctx) => ({
      table: ctx.child(tableController, { rowCount }),
    }),
    { name: 'app' },
  )
  return createRoot(appController, { deps: { api }, queries: queryEngine() })
}

export type AppRoot = ReturnType<typeof createAppRoot>

export type AppApi = AppRoot['api']
