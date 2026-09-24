import { describe, it } from 'vitest'
import { asyncState } from '../../src/transforms/async-state'
import { expectFixture } from '../harness'

describe('async-state', () => {
  it('renames promise to firstValue on an AsyncState only', () => {
    expectFixture(asyncState, 'async-state', { changed: 2, todos: [] })
  })
})
