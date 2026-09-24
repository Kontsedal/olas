import { describe, it } from 'vitest'
import { ENTITIES_PLUGIN_TYPE, ENTITY_STORE, entities } from '../../src/transforms/entities'
import { expectFixture } from '../harness'

describe('entities', () => {
  it('wraps the entity list in options, renames invalidate, and reports store reads', () => {
    expectFixture(entities, 'entities', {
      changed: 3,
      todos: [
        [2, ENTITIES_PLUGIN_TYPE],
        [13, ENTITY_STORE],
        [14, ENTITY_STORE],
        [15, ENTITY_STORE],
      ],
    })
  })
})
