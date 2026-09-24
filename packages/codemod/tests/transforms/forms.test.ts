import { describe, it } from 'vitest'
import { forms, SUBMIT_RESULT } from '../../src/transforms/forms'
import { expectFixture } from '../harness'

describe('forms', () => {
  it('drops the `.value` signal hop of a Form or FieldArray, and renames resetWithInitial', () => {
    expectFixture(forms, 'forms', {
      changed: 7,
      todos: [[36, SUBMIT_RESULT]],
      idempotent: false,
    })
  })
})
