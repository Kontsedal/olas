/**
 * Preferences feature — usePersisted round-trip across two roots wired to the
 * same in-memory storage adapter (a stand-in for two browser tabs).
 */

import { describe, expect, test } from 'vitest'
import { createKanbanRoot, flush, memoryStorage } from './helpers'

describe('preferences', () => {
  test('theme persists across a root restart through the same storage', async () => {
    const storage = memoryStorage()
    const a = createKanbanRoot({ storage })
    try {
      await flush()
      a.root.preferences.setTheme('dark')
      await flush()
    } finally {
      a.dispose()
    }
    // Second root reads the persisted value.
    const b = createKanbanRoot({ storage })
    try {
      await flush()
      expect(b.root.preferences.prefs.peek().theme).toBe('dark')
    } finally {
      b.dispose()
    }
  })

  test('density toggles between compact and comfortable', async () => {
    const { root, dispose } = createKanbanRoot()
    try {
      expect(root.preferences.prefs.peek().density).toBe('compact')
      root.preferences.setDensity('comfortable')
      expect(root.preferences.prefs.peek().density).toBe('comfortable')
    } finally {
      dispose()
    }
  })
})
