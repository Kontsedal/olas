/**
 * Preferences feature — theme, density, sidebar collapse, last-open board,
 * plus visibility toggles for activity/archive panels.
 *
 * Library primitives demonstrated:
 *  - `usePersisted(ctx, key, signal)` — Signals satisfy `PersistableSource`
 *    so we pass them straight through. localStorage round-trip happens via
 *    the default adapter; tests inject `ctx.deps.storage` if needed.
 *  - Standalone `effect()` — mirrors theme + density to `<html data-*>`.
 *    Cleanup is registered with `ctx.onDispose` so it dies with the
 *    controller, not with the page.
 */

import { type Ctx, effect, signal } from '@kontsedal/olas-core'
import { type StorageAdapter, usePersisted } from '@kontsedal/olas-persist'
import type { DensityPref, Preferences, ThemePref } from '../../scopes'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    /**
     * Storage backend for persisted preferences. Optional — when omitted the
     * usePersisted call falls back to `localStorageAdapter`.
     */
    storage?: StorageAdapter | undefined
  }
}

const DEFAULTS: Preferences = {
  theme: 'auto',
  density: 'compact',
  sidebarCollapsed: false,
  lastBoardId: null,
  showActivity: true,
  showArchive: false,
}

const STORAGE_KEY = 'olas-kanban.prefs'

export function createPreferences(ctx: Ctx) {
  const prefs = signal<Preferences>(DEFAULTS)

  usePersisted(ctx, STORAGE_KEY, prefs, { storage: ctx.deps.storage, crossTab: true })

  // Mirror theme + density to <html> attributes so the CSS tokens flip.
  // Skipping this on the server (no `document`) keeps SSR-safe.
  if (typeof document !== 'undefined') {
    const cleanup = effect(() => {
      const p = prefs.value
      document.documentElement.dataset.theme = p.theme
      document.documentElement.dataset.density = p.density
    })
    ctx.onDispose(cleanup)
  }

  const patch = (mut: Partial<Preferences>): void => {
    prefs.update((p) => ({ ...p, ...mut }))
  }

  return {
    prefs,
    setTheme: (theme: ThemePref) => patch({ theme }),
    setDensity: (density: DensityPref) => patch({ density }),
    toggleSidebar: () => patch({ sidebarCollapsed: !prefs.peek().sidebarCollapsed }),
    toggleActivity: () => patch({ showActivity: !prefs.peek().showActivity }),
    toggleArchive: () => patch({ showArchive: !prefs.peek().showArchive }),
    setLastBoardId: (id: string) => patch({ lastBoardId: id }),
  }
}

export type PreferencesApi = ReturnType<typeof createPreferences>
