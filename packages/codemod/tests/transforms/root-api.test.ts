import { describe, it } from 'vitest'
import {
  APPLY_DEHYDRATED,
  MIXED_DESTRUCTURE,
  RENAMED_CONTROL,
  ROOT_SPREAD,
  rootApi,
} from '../../src/transforms/root-api'
import { expectFixture } from '../harness'

describe('root-api', () => {
  it('moves api access onto root.api where the type proves it, and renames __debug', () => {
    expectFixture(rootApi, 'root-api', {
      changed: 11,
      todos: [
        [18, APPLY_DEHYDRATED],
        [22, MIXED_DESTRUCTURE],
        [23, RENAMED_CONTROL],
        [25, ROOT_SPREAD],
      ],
    })
  })
})
