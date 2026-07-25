// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { JsonView } from '../src/JsonView'

afterEach(() => cleanup())

describe('JsonView cycle guard (T6.3)', () => {
  test('a SHARED (non-cyclic) reference is not falsely reported as [Circular]', () => {
    // `a` and `b` point at the same object — a DAG, NOT a cycle. The old guard
    // mutated one shared seen-set, so the second occurrence read as [Circular].
    const shared = { hello: 'world' }
    const { container } = render(<JsonView value={{ a: shared, b: shared }} />)
    expect(container.textContent).not.toContain('[Circular]')
  })

  test('shared references survive <StrictMode> double-render', () => {
    const shared = { n: 1 }
    const { container } = render(
      <StrictMode>
        <JsonView value={{ x: shared, y: shared, z: shared }} />
      </StrictMode>,
    )
    expect(container.textContent).not.toContain('[Circular]')
  })

  test('a TRUE cycle IS still reported as [Circular] (guardrail)', () => {
    const cyclic: Record<string, unknown> = { name: 'root' }
    cyclic.self = cyclic
    const { container } = render(<JsonView value={cyclic} />)
    expect(container.textContent).toContain('[Circular]')
  })
})
