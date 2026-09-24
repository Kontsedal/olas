import { describe, it } from 'vitest'
import { USE_CONTROLLER, useController } from '../../src/transforms/use-controller'
import { expectFixture } from '../harness'

describe('use-controller', () => {
  it('replaces useController(root) with root.api and drops the import', () => {
    expectFixture(useController, 'use-controller', { changed: 4, todos: [] })
  })

  it('keeps the import and reports each use that is not a one-argument call', () => {
    expectFixture(useController, 'use-controller-kept', {
      changed: 1,
      todos: [
        [7, USE_CONTROLLER],
        [8, USE_CONTROLLER],
        [9, USE_CONTROLLER],
      ],
    })
  })
})
