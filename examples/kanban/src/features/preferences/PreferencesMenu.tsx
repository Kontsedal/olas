/**
 * Header menu — theme, density, panel visibility toggles. Reads from
 * `preferencesScope` so any descendant can mount it (we put it in the header).
 */

import { use, useRoot } from '@kontsedal/olas-react'
import { Archive, Moon, ScrollText, Sun, SunMoon } from 'lucide-react'
import type { AppApi } from '../../app.controller'
import { IconButton } from '../../ui'

export function PreferencesMenu() {
  const app = useRoot<AppApi>()
  const prefs = use(app.preferences.prefs)
  const { setTheme, setDensity, toggleActivity, toggleArchive } = app.preferences

  const nextTheme: Record<typeof prefs.theme, typeof prefs.theme> = {
    light: 'dark',
    dark: 'auto',
    auto: 'light',
  }

  const ThemeIcon = prefs.theme === 'light' ? Sun : prefs.theme === 'dark' ? Moon : SunMoon

  return (
    <div className="olas-prefmenu">
      <IconButton
        size="sm"
        label="Cycle theme"
        title={`Theme: ${prefs.theme} (click to cycle)`}
        onClick={() => setTheme(nextTheme[prefs.theme])}
      >
        <ThemeIcon size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label="Toggle density"
        title={`Density: ${prefs.density}`}
        pressed={prefs.density === 'comfortable'}
        onClick={() => setDensity(prefs.density === 'compact' ? 'comfortable' : 'compact')}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '-0.05em' }}>
          {prefs.density === 'compact' ? '··' : '· ·'}
        </span>
      </IconButton>
      <IconButton
        size="sm"
        label="Toggle activity"
        title={`${prefs.showActivity ? 'Hide' : 'Show'} activity`}
        pressed={prefs.showActivity}
        onClick={toggleActivity}
      >
        <ScrollText size={14} />
      </IconButton>
      <IconButton
        size="sm"
        label="Toggle archive"
        title={`${prefs.showArchive ? 'Hide' : 'Show'} archive`}
        pressed={prefs.showArchive}
        onClick={toggleArchive}
      >
        <Archive size={14} />
      </IconButton>
    </div>
  )
}
