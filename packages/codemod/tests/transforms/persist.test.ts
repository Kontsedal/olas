import { describe, it } from 'vitest'
import { CLEAR_ALL, CLEAR_PREFIX, persist } from '../../src/transforms/persist'
import { expectFixture } from '../harness'

describe('persist', () => {
  it('calls the localStorage adapter factory and passes clearPersisted an options object', () => {
    expectFixture(persist, 'persist', {
      changed: 15,
      todos: [
        [23, CLEAR_ALL],
        [24, CLEAR_ALL],
        [27, CLEAR_PREFIX],
        [28, CLEAR_PREFIX],
        [29, CLEAR_ALL],
      ],
    })
  })
})
