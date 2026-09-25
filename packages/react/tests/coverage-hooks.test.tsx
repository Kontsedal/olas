// @vitest-environment jsdom

import {
  createField,
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
  required,
} from '@kontsedal/olas-core'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { OlasProvider, useField, useMutation, useSuspenseQuery } from '../src'

afterEach(() => {
  cleanup()
})

describe('useSuspenseQuery', () => {
  test('suspends until the first value lands, then renders it', async () => {
    let resolve!: (v: string) => void
    const q = defineQuery({
      id: 'cov-hooks/suspense',
      key: () => [],
      fetcher: () =>
        new Promise<string>((r) => {
          resolve = r
        }),
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ user: createQuery(ctx, q) })),
      { queries: queryEngine(), deps: {} },
    )
    function View() {
      const { data, status } = useSuspenseQuery(root.api.user)
      return (
        <span data-testid="user">
          {data.toUpperCase()}:{status}
        </span>
      )
    }
    render(
      <OlasProvider root={root}>
        <Suspense fallback={<span data-testid="fallback">loading</span>}>
          <View />
        </Suspense>
      </OlasProvider>,
    )
    expect(screen.getByTestId('fallback').textContent).toBe('loading')
    await act(async () => {
      resolve('ada')
      await root.api.user.firstValue()
    })
    expect(screen.queryByTestId('fallback')).toBeNull()
    expect(screen.getByTestId('user').textContent).toBe('ADA:success')
    root.dispose()
  })
})

describe('useField actions', () => {
  test('setAsInitial re-anchors the clean value, and reset returns to it', () => {
    const root = createRoot(
      defineController((ctx) => ({ name: createField<string>(ctx, 'a') })),
      { deps: {} },
    )
    const { result } = renderHook(() => useField(root.api.name))

    act(() => result.current.set('b'))
    expect(result.current.isDirty).toBe(true)

    act(() => result.current.setAsInitial('server'))
    expect(result.current.value).toBe('server')
    expect(result.current.isDirty).toBe(false)

    act(() => {
      result.current.set('edited')
      result.current.markTouched()
    })
    expect(result.current.isDirty).toBe(true)
    expect(result.current.touched).toBe(true)

    act(() => result.current.reset())
    expect(result.current.value).toBe('server')
    expect(result.current.isDirty).toBe(false)
    expect(result.current.touched).toBe(false)
    root.dispose()
  })

  test('setErrors pins external errors until the next user write', () => {
    const root = createRoot(
      defineController((ctx) => ({ name: createField<string>(ctx, 'ada') })),
      { deps: {} },
    )
    const { result } = renderHook(() => useField(root.api.name))
    expect(result.current.isValid).toBe(true)

    act(() => result.current.setErrors(['Username taken']))
    expect(result.current.errors).toEqual(['Username taken'])
    expect(result.current.isValid).toBe(false)

    act(() => result.current.set('grace'))
    expect(result.current.errors).toEqual([])
    expect(result.current.isValid).toBe(true)
    root.dispose()
  })

  test('revalidate unlocks a submit-mode field and resolves with its validity', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        name: createField<string>(ctx, '', { validators: [required()], validateOn: 'submit' }),
      })),
      { deps: {} },
    )
    const { result } = renderHook(() => useField(root.api.name))
    // Submit mode: no errors show before the first revalidate.
    expect(result.current.errors).toEqual([])

    let valid: boolean | undefined
    await act(async () => {
      valid = await result.current.revalidate()
    })
    expect(valid).toBe(false)
    expect(result.current.errors).toEqual(['Required'])

    await act(async () => {
      result.current.set('ada')
      valid = await result.current.revalidate()
    })
    expect(valid).toBe(true)
    expect(result.current.errors).toEqual([])
    root.dispose()
  })
})

describe('useMutation reset', () => {
  test('clears a failed run back to idle', async () => {
    const boom = new Error('boom')
    const root = createRoot(
      defineController((ctx) => ({
        save: createMutation(ctx, {
          mutate: async (_v: number): Promise<number> => {
            throw boom
          },
        }),
      })),
      { queries: queryEngine(), deps: {}, onError: () => {} },
    )
    const { result } = renderHook(() => useMutation(root.api.save))
    await act(async () => {
      await result.current.run(1).catch(() => {})
    })
    expect(result.current.isError).toBe(true)
    expect(result.current.lastVariables).toBe(1)

    act(() => result.current.reset())
    expect(result.current.status).toBe('idle')
    expect(result.current.isIdle).toBe(true)
    expect(result.current.error).toBeUndefined()
    expect(result.current.lastVariables).toBeUndefined()
    root.dispose()
  })

  test('a reset mid-run aborts it: the run rejects and no callback fires', async () => {
    const root = createRoot(
      defineController((ctx) => ({
        save: createMutation(ctx, {
          mutate: (v: number, { signal }) =>
            new Promise<number>((resolve, reject) => {
              const t = setTimeout(() => resolve(v), 20)
              signal.addEventListener('abort', () => {
                clearTimeout(t)
                reject(new DOMException('Aborted', 'AbortError'))
              })
            }),
        }),
      })),
      { queries: queryEngine(), deps: {} },
    )
    const onSuccess = vi.fn()
    const onError = vi.fn()
    const onSettled = vi.fn()
    const { result } = renderHook(() =>
      useMutation(root.api.save, { onSuccess, onError, onSettled }),
    )
    let err: unknown
    await act(async () => {
      const pending = result.current.run(5).catch((e: unknown) => e)
      result.current.reset()
      err = await pending
    })
    expect((err as Error).name).toBe('AbortError')
    expect(result.current.status).toBe('idle')
    expect(result.current.isPending).toBe(false)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onSettled).not.toHaveBeenCalled()
    root.dispose()
  })
})
