import { describe, it } from 'vitest'
import {
  ADAPTER_VARIABLE,
  mutationQueue,
  REPLAY_NOW,
  REPLAY_SETTLE,
} from '../../src/transforms/mutation-queue'
import { expectFixture } from '../harness'

describe('mutation-queue', () => {
  it('renames adapter to storage, and reports replayNow and a three-argument onReplaySettle', () => {
    expectFixture(mutationQueue, 'mutation-queue', {
      changed: 3,
      todos: [
        [10, REPLAY_SETTLE],
        [21, ADAPTER_VARIABLE],
        [27, REPLAY_NOW],
      ],
    })
  })
})
