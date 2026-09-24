import { describe, it } from 'vitest'
import { errorContext } from '../../src/transforms/error-context'
import { expectFixture } from '../harness'

describe('error-context', () => {
  it('renames queryKey to key and mutationName to mutationId, in accesses and patterns', () => {
    expectFixture(errorContext, 'error-context', { changed: 4, todos: [] })
  })
})
