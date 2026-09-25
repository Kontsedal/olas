import { createRoot, queryEngine } from '@kontsedal/olas-core'
import type { TasksApi } from './api'
import { appController } from './controller'

/** The app's root, built once, outside Vue. */
export function createAppRoot(api: TasksApi) {
  return createRoot(appController, { deps: { api }, queries: queryEngine() })
}

export type AppRoot = ReturnType<typeof createAppRoot>

// Register the root's type once, so `useRoot()` returns the app api in every
// component without a type argument.
declare module '@kontsedal/olas-vue' {
  interface Register {
    root: AppRoot
  }
}
