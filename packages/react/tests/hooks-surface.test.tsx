// @vitest-environment jsdom

import {
  createMutation,
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useMutation, useQuery } from '../src'

afterEach(() => {
  cleanup()
})

describe('useMutation — mutate is fire-and-forget, run returns the promise', () => {
  test('a failed mutate lands on error/status and onError, and rejects nothing', async () => {
    const boom = new Error('boom')
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        mutate: async (_v: number) => {
          throw boom
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })
    const onError = vi.fn()
    const onSettled = vi.fn()
    // Vitest fails the run on an unhandled rejection, so a `mutate` that leaked
    // one would fail this file.
    const { result } = renderHook(() => useMutation(root.api.save, { onError, onSettled }))
    let returned: unknown = 'not called'
    await act(async () => {
      returned = result.current.mutate(1)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(returned).toBeUndefined()
    expect(result.current.status).toBe('error')
    expect(result.current.isError).toBe(true)
    expect(result.current.error).toBe(boom)
    expect(onError).toHaveBeenCalledWith(boom, 1)
    expect(onSettled).toHaveBeenCalledWith(undefined, boom, 1)
    root.dispose()
  })

  test('run resolves with the result and runs onSuccess; a failed run rejects', async () => {
    let fail = false
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        mutate: async (v: number) => {
          if (fail) throw new Error('nope')
          return v * 2
        },
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })
    const onSuccess = vi.fn()
    const { result } = renderHook(() => useMutation(root.api.save, { onSuccess }))
    await act(async () => {
      await expect(result.current.run(21)).resolves.toBe(42)
    })
    expect(onSuccess).toHaveBeenCalledWith(42, 21)
    expect(result.current.status).toBe('success')
    expect(result.current.data).toBe(42)
    fail = true
    await act(async () => {
      await expect(result.current.run(1)).rejects.toThrow('nope')
    })
    root.dispose()
  })

  test('a superseded latest-wins run fires no callbacks', async () => {
    const def = defineController((ctx) => ({
      save: createMutation(ctx, {
        concurrency: 'latest-wins',
        mutate: (v: number, { signal }) =>
          new Promise<number>((resolve, reject) => {
            const t = setTimeout(() => resolve(v), 20)
            signal.addEventListener('abort', () => {
              clearTimeout(t)
              reject(new DOMException('Aborted', 'AbortError'))
            })
          }),
      }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    const onError = vi.fn()
    const onSuccess = vi.fn()
    const onSettled = vi.fn()
    const { result } = renderHook(() =>
      useMutation(root.api.save, { onError, onSuccess, onSettled }),
    )
    await act(async () => {
      const first = result.current.run(1).catch((e: unknown) => e)
      const second = result.current.run(2)
      expect(((await first) as Error).name).toBe('AbortError')
      await second
    })
    expect(onError).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith(2, 2)
    expect(onSettled).toHaveBeenCalledTimes(1)
    root.dispose()
  })

  test('mutate, run and reset keep their identity across renders', async () => {
    const def = defineController((ctx) => ({
      save: createMutation(ctx, { mutate: async (v: number) => v }),
    }))
    const root = createRoot(def, { queries: queryEngine(), deps: {} })
    const { result, rerender } = renderHook(() => useMutation(root.api.save))
    const before = result.current
    await act(async () => {
      await result.current.run(1)
    })
    rerender()
    expect(result.current.mutate).toBe(before.mutate)
    expect(result.current.run).toBe(before.run)
    expect(result.current.reset).toBe(before.reset)
    root.dispose()
  })
})

describe('useQuery — the full AsyncState surface', () => {
  test('returns isPaused, reset and cancel; cancel stops the in-flight fetch', async () => {
    let calls = 0
    const q = defineQuery({
      id: 'hooks-surface/cancel',
      key: () => [],
      fetcher: ({ signal }) =>
        new Promise<string>((resolve, reject) => {
          calls += 1
          const t = setTimeout(() => resolve('late'), 50)
          signal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    })
    const def = defineController((ctx) => ({ sub: createQuery(ctx, q, () => []) }))
    const root = createRoot(def, { queries: queryEngine(), deps: {}, onError: () => {} })
    const { result } = renderHook(() => useQuery(root.api.sub))
    expect(result.current.isPaused).toBe(false)
    expect(result.current.isFetching).toBe(true)
    expect(typeof result.current.reset).toBe('function')
    act(() => {
      result.current.cancel()
    })
    expect(result.current.isFetching).toBe(false)
    expect(result.current.data).toBeUndefined()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 70))
    })
    expect(result.current.data).toBeUndefined() // the aborted response never landed
    expect(calls).toBe(1)
    root.dispose()
  })
})
