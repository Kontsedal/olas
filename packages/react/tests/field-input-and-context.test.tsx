// @vitest-environment jsdom

import {
  createField,
  createRoot,
  defineController,
  queryEngine,
  required,
  signal,
} from '@kontsedal/olas-core'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'
import { createOlasContext, useFieldInput } from '../src'

afterEach(() => {
  cleanup()
})

describe('useFieldInput', () => {
  test('binds a string field to a native input: value, change, blur, aria-invalid', () => {
    const def = defineController((ctx) => ({
      name: createField<string>(ctx, '', { validators: [required('Required')] }),
    }))
    const root = createRoot(def, { deps: {} })
    function View() {
      return <input data-testid="in" {...useFieldInput(root.api.name, { name: 'name' })} />
    }
    render(<View />)
    const input = screen.getByTestId('in') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.name).toBe('name')
    // Invalid but untouched: no aria-invalid yet.
    expect(input.getAttribute('aria-invalid')).toBeNull()
    fireEvent.blur(input)
    expect(root.api.name.touched.value).toBe(true)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(input, { target: { value: 'Ada' } })
    expect(root.api.name.value).toBe('Ada')
    expect(input.value).toBe('Ada')
    expect(input.getAttribute('aria-invalid')).toBeNull()
    root.dispose()
  })

  test('a transform converts between the field value and the input string', () => {
    const def = defineController((ctx) => ({ age: createField<number>(ctx, 30) }))
    const root = createRoot(def, { deps: {} })
    const transform = { parse: Number, format: String }
    function View() {
      return <input data-testid="age" {...useFieldInput(root.api.age, { transform })} />
    }
    render(<View />)
    const input = screen.getByTestId('age') as HTMLInputElement
    expect(input.value).toBe('30')
    fireEvent.change(input, { target: { value: '41' } })
    expect(root.api.age.value).toBe(41)
    root.dispose()
  })

  test('handler identity holds across renders even with an inline transform', () => {
    const def = defineController((ctx) => ({ age: createField<number>(ctx, 1) }))
    const root = createRoot(def, { deps: {} })
    const { result, rerender } = renderHook(() =>
      useFieldInput(root.api.age, { transform: { parse: Number, format: String } }),
    )
    const first = result.current
    act(() => root.api.age.set(2))
    rerender()
    expect(result.current.onChange).toBe(first.onChange)
    expect(result.current.onBlur).toBe(first.onBlur)
    expect(result.current.value).toBe('2')
    root.dispose()
  })
})

describe('createOlasContext — one typed context per root', () => {
  test('two roots, two contexts: each useRoot reads its own api', () => {
    const auth = createOlasContext<{ user: string }>('AuthRoot')
    const app = createOlasContext<{ count: ReturnType<typeof signal<number>> }>('AppRoot')
    const authRoot = createRoot(
      defineController(() => ({ user: 'ada' })),
      { deps: {} },
    )
    const appRoot = createRoot(
      defineController(() => ({ count: signal(3) })),
      { queries: queryEngine(), deps: {} },
    )
    function View() {
      const { user } = auth.useRoot()
      const { count } = app.useRoot()
      return (
        <span data-testid="out">
          {user}:{count.value}
        </span>
      )
    }
    render(
      <auth.Provider root={authRoot}>
        <app.Provider root={appRoot}>
          <View />
        </app.Provider>
      </auth.Provider>,
    )
    expect(screen.getByTestId('out').textContent).toBe('ada:3')
    authRoot.dispose()
    appRoot.dispose()
  })

  test('outside its provider, useRoot throws naming the context', () => {
    const auth = createOlasContext<{ user: string }>('AuthRoot')
    const prev = console.error
    console.error = () => {}
    try {
      expect(() => renderHook(() => auth.useRoot())).toThrow(/outside AuthRoot/)
    } finally {
      console.error = prev
    }
  })
})
