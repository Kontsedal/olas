/**
 * Top-level React layout. Three-pane shell:
 *   ┌──────────┬─────────────────────────────┬─────────────┐
 *   │ Sidebar  │  Header (search + filters)  │   Detail    │
 *   │  (boards)│  Board grid                 │   (card)    │
 *   │          │  Activity feed              │             │
 *   │          │  Archive drawer             │             │
 *   └──────────┴─────────────────────────────┴─────────────┘
 *
 * `OlasProvider` exposes `appController`'s api via `useRoot()` /
 * `useController(appController)`. We also wire `useSuspendOnHidden(root)`
 * so background tabs stop polling.
 */

import type { Root } from '@kontsedal/olas-core'
import { DevtoolsLauncher } from '@kontsedal/olas-devtools'
import { OlasProvider, useSuspendOnHidden } from '@kontsedal/olas-react'
import type { AppApi } from './app.controller'
import { ActivityFeed } from './features/activity/ActivityFeed'
import { ArchiveDrawer } from './features/archive/ArchiveDrawer'
import { Board } from './features/board/Board'
import { Sidebar } from './features/boards/Sidebar'
import { CardDetail } from './features/card-detail/CardDetail'
import { Notifications } from './features/notifications/Notifications'
import { PreferencesMenu } from './features/preferences/PreferencesMenu'

export function App({ root }: { root: Root<AppApi> }) {
  useSuspendOnHidden(root)
  return (
    <OlasProvider root={root}>
      <div className="olas-shell">
        <Sidebar />
        <main className="olas-main">
          <div className="olas-topbar">
            <span className="olas-topbar-title">Flagship</span>
            <span className="olas-topbar-spacer" />
            <PreferencesMenu />
          </div>
          <Board />
          <ActivityFeed />
          <ArchiveDrawer />
        </main>
        <CardDetail />
      </div>
      <Notifications />
      <DevtoolsLauncher root={root} />
    </OlasProvider>
  )
}
