import { describe, it } from 'vitest'
import { renames, ZOD_INITIALS } from '../../src/transforms/renames'
import { expectFixture } from '../harness'

describe('renames', () => {
  it('renames imports, their references, re-exports and namespace members', () => {
    expectFixture(renames, 'renames', { changed: 18, todos: [[37, ZOD_INITIALS]] })
  })

  it('keeps an alias when the new name is taken, and merges into an import of the new name', () => {
    expectFixture(renames, 'renames-conflicts', { changed: 2, todos: [] })
  })
})
