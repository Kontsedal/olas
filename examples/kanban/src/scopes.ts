/**
 * Typed cross-tree data slots — `provide` on parents, `inject` on descendants.
 * Each scope value is owned by exactly one provider so the type contract is
 * unambiguous. See spec §10.3.
 */

import { defineScope, type Emitter, type Signal } from '@kontsedal/olas-core'

/* Provided by `appController` — global notifications stream (toasts). */

export type NotificationKind = 'info' | 'success' | 'error'
export type NotificationEvent = {
  id: string
  kind: NotificationKind
  title: string
  message?: string
  /** Optional retry hook surfaced as the toast's CTA. */
  retry?: () => void
}
export const notificationsScope = defineScope<Emitter<NotificationEvent>>({ name: 'notifications' })

/* Provided by `appController` — global activity feed. */

export type ActivityEvent = {
  id: string
  ts: number
  kind: 'move' | 'save' | 'create' | 'archive' | 'restore' | 'comment' | 'error' | 'remote'
  text: string
  /** Optional user id — when present, the feed renders the avatar. */
  authorId?: string
  /** True for events received from the realtime channel (remote actors). */
  isRemote?: boolean
}
export const activityScope = defineScope<Emitter<ActivityEvent>>({ name: 'activity' })

/* Provided by `appController` — UI preferences (persisted). */

export type ThemePref = 'light' | 'dark' | 'auto'
export type DensityPref = 'compact' | 'comfortable'

export type Preferences = {
  theme: ThemePref
  density: DensityPref
  sidebarCollapsed: boolean
  lastBoardId: string | null
  showActivity: boolean
  showArchive: boolean
}
export const preferencesScope = defineScope<{
  prefs: Signal<Preferences>
  setTheme: (v: ThemePref) => void
  setDensity: (v: DensityPref) => void
  toggleSidebar: () => void
  toggleActivity: () => void
  setLastBoardId: (id: string) => void
}>({ name: 'preferences' })

/* Provided by `boardsController` — the currently active board id. */

export const activeBoardScope = defineScope<{
  activeBoardId: Signal<string>
  setActive: (id: string) => void
}>({ name: 'activeBoard' })

/* Provided by `boardController` — the card the detail pane is showing. */

export const selectedCardScope = defineScope<{
  selectedCardId: Signal<string | null>
  open: (cardId: string) => void
  close: () => void
}>({ name: 'selectedCard' })
