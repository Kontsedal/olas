import { describe, it } from 'vitest'
import { createField, FIELD_THIRD_ARGUMENT } from '../../src/transforms/create-field'
import { expectFixture } from '../harness'

describe('create-field', () => {
  it('folds positional validators and options into one options object', () => {
    expectFixture(createField, 'create-field', {
      changed: 8,
      todos: [[26, FIELD_THIRD_ARGUMENT]],
    })
  })
})
