import { describe, it } from 'vitest'
import { ctxPrimitives, SESSION } from '../../src/transforms/ctx-primitives'
import { expectFixture } from '../harness'

describe('ctx-primitives', () => {
  it('turns ctx methods into imported functions that take ctx first', () => {
    expectFixture(ctxPrimitives, 'ctx-primitives', {
      changed: 12,
      todos: [
        [21, SESSION],
        [33, 'a local `signal` hides the import here: rewrite `ctx.signal` by hand'],
      ],
    })
  })
})
