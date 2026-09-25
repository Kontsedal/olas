import { describe, it } from 'vitest'
import {
  MUTATE_DESTRUCTURED,
  MUTATE_RETURNED,
  reactMutation,
} from '../../src/transforms/react-mutation'
import { expectFixture } from '../harness'

describe('react-mutation', () => {
  it('turns mutateAsync and every used mutate promise into run, and keeps fire-and-forget calls', () => {
    expectFixture(reactMutation, 'react-mutation', {
      changed: 6,
      todos: [
        [21, MUTATE_DESTRUCTURED],
        [27, MUTATE_RETURNED],
        [28, MUTATE_RETURNED],
      ],
    })
  })
})
