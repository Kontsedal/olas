import { describe, it } from 'vitest'
import { MAX_IDLE_VARIABLE, suspendOptions } from '../../src/transforms/suspend-options'
import { expectFixture } from '../harness'

describe('suspend-options', () => {
  it('renames maxIdle to maxIdleTime on a root suspend', () => {
    expectFixture(suspendOptions, 'suspend-options', {
      changed: 2,
      todos: [[14, MAX_IDLE_VARIABLE]],
    })
  })
})
