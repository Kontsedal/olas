import { describe, it } from 'vitest'
import {
  ENGINE_HIDDEN,
  ENGINE_UNSEEN,
  OPTIONS_UNSEEN,
  ROUTER_SCOPES,
  rootOptions,
} from '../../src/transforms/root-options'
import { expectFixture } from '../harness'

describe('root-options', () => {
  it('adds the query engine, moves the query defaults into it, and installs the router as a plugin', () => {
    expectFixture(rootOptions, 'root-options', {
      changed: 16,
      todos: [
        [37, ROUTER_SCOPES],
        [39, ROUTER_SCOPES],
        [48, ENGINE_UNSEEN],
        [52, OPTIONS_UNSEEN],
        [72, OPTIONS_UNSEEN],
      ],
    })
  })

  it('reports a root whose file already has another `queryEngine`', () => {
    expectFixture(rootOptions, 'root-options-hidden', {
      changed: 0,
      todos: [[7, ENGINE_HIDDEN]],
    })
  })
})
