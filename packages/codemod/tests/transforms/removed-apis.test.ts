import { describe, it } from 'vitest'
import { REMOVED, removedApis } from '../../src/transforms/removed-apis'
import { expectFixture } from '../harness'

const todo = (line: number, name: string): [number, string] => [
  line,
  `\`${name}\`: ${REMOVED.get(name)}`,
]

describe('removed-apis', () => {
  it('reports each import of a removed core export and rewrites nothing', () => {
    expectFixture(removedApis, 'removed-apis', {
      changed: 0,
      todos: [
        todo(2, 'isStandardSchema'),
        todo(3, 'lookupRegisteredMutation'),
        todo(4, 'lookupRegisteredQuery'),
        todo(5, 'QueryClientPlugin'),
        todo(7, 'stableHash'),
        todo(10, 'ErrorContextInput'),
        todo(11, 'GcEvent'),
        todo(12, 'InvalidateEvent'),
        todo(13, 'MutationEnqueueEvent'),
        todo(14, 'MutationSettleEvent'),
        todo(15, 'QueryClientPluginApi'),
        todo(16, 'RegisteredMutation'),
        todo(17, 'RegisteredQuery'),
        todo(18, 'SetDataEvent'),
      ],
    })
  })
})
