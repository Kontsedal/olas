import { describe, it } from 'vitest'
import {
  DEFINITION_HOOKS,
  identityMeta,
  MUTATION_ID,
  MUTATION_SPEC_UNSEEN,
  PLACEHOLDER_ID,
  QUERY_SPEC_UNSEEN,
  SPREAD_DEFINITION,
} from '../../src/transforms/identity-meta'
import { expectFixture } from '../harness'

describe('identity-meta', () => {
  it('names queries and mutations by id, moves plugin flags under meta, and splits a spread definition', () => {
    expectFixture(identityMeta, 'identity-meta', {
      changed: 30,
      todos: [
        [17, PLACEHOLDER_ID],
        [18, PLACEHOLDER_ID],
        [26, QUERY_SPEC_UNSEEN],
        [27, QUERY_SPEC_UNSEEN],
        [36, DEFINITION_HOOKS],
        [38, MUTATION_SPEC_UNSEEN],
        [40, MUTATION_ID],
        [49, SPREAD_DEFINITION],
        [50, SPREAD_DEFINITION],
        [57, MUTATION_SPEC_UNSEEN],
      ],
    })
  })
})
