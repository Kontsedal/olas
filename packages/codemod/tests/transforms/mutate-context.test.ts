import { describe, it } from 'vitest'
import {
  CACHE_REFERENCE,
  MUTATE_REFERENCE,
  mutateContext,
} from '../../src/transforms/mutate-context'
import { expectFixture } from '../harness'

describe('mutate-context', () => {
  it('destructures signal from the new context parameter of mutate and createCache', () => {
    expectFixture(mutateContext, 'mutate-context', {
      changed: 7,
      todos: [
        [20, MUTATE_REFERENCE],
        [29, MUTATE_REFERENCE],
        [34, CACHE_REFERENCE],
      ],
    })
  })
})
