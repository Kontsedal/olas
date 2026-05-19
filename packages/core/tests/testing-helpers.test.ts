import { describe, expect, test, vi } from 'vitest'
import { fakeAsyncState, fakeField } from '../src/testing'

describe('fakeField', () => {
  test('exposes the initial value via .value / peek / subscribe', () => {
    const f = fakeField('hello')
    expect(f.value).toBe('hello')
    expect(f.peek()).toBe('hello')

    const seen: string[] = []
    const unsub = f.subscribe((v) => seen.push(v))
    expect(seen).toEqual(['hello'])
    f.set('world')
    expect(seen).toEqual(['hello', 'world'])
    expect(f.value).toBe('world')
    unsub()
  })

  test('defaults: isValid is true (no errors), isDirty/touched/isValidating false', () => {
    const f = fakeField(0)
    expect(f.errors.value).toEqual([])
    expect(f.isValid.value).toBe(true)
    expect(f.isDirty.value).toBe(false)
    expect(f.touched.value).toBe(false)
    expect(f.isValidating.value).toBe(false)
  })

  test('isValid derives from errors + validating when not explicitly overridden', () => {
    const f = fakeField('x', { errors: ['bad'] })
    expect(f.isValid.value).toBe(false)
    const g = fakeField('x', { isValidating: true })
    expect(g.isValid.value).toBe(false)
  })

  test('isValid override wins over derived signal', () => {
    const f = fakeField('', { errors: ['required'], isValid: true })
    expect(f.isValid.value).toBe(true)
  })

  test('setAsInitial reseats the baseline so reset() returns to it', () => {
    const f = fakeField('a')
    f.setAsInitial('b')
    expect(f.value).toBe('b')
    expect(f.isDirty.value).toBe(false)
    f.set('c')
    f.reset()
    expect(f.value).toBe('b')
  })

  test('markTouched flips touched signal', () => {
    const f = fakeField('a')
    expect(f.touched.value).toBe(false)
    f.markTouched()
    expect(f.touched.value).toBe(true)
  })

  test('revalidate default returns true when no errors, false when errors present', async () => {
    const f = fakeField('a')
    await expect(f.revalidate()).resolves.toBe(true)
    const g = fakeField('a', { errors: ['oops'] })
    await expect(g.revalidate()).resolves.toBe(false)
  })

  test('overrides for set / setAsInitial / reset / markTouched / revalidate / dispose are honored', async () => {
    const setSpy = vi.fn<(v: string) => void>()
    const setAsInitialSpy = vi.fn<(v: string) => void>()
    const resetSpy = vi.fn()
    const touchedSpy = vi.fn()
    const revalidateSpy = vi.fn(async () => false)
    const disposeSpy = vi.fn()

    // Literal narrowing pitfall — without an explicit type arg, the inferred
    // type would be Field<'start'> and `.set('x')` would not typecheck.
    const f = fakeField<string>('start', {
      set: setSpy,
      setAsInitial: setAsInitialSpy,
      reset: resetSpy,
      markTouched: touchedSpy,
      revalidate: revalidateSpy,
      dispose: disposeSpy,
    })
    f.set('x')
    f.setAsInitial('y')
    f.reset()
    f.markTouched()
    await f.revalidate()
    f.dispose()

    expect(setSpy).toHaveBeenCalledWith('x')
    expect(setAsInitialSpy).toHaveBeenCalledWith('y')
    expect(resetSpy).toHaveBeenCalled()
    expect(touchedSpy).toHaveBeenCalled()
    expect(revalidateSpy).toHaveBeenCalled()
    expect(disposeSpy).toHaveBeenCalled()
  })

  test('default dispose is a no-op', () => {
    const f = fakeField('a')
    expect(() => f.dispose()).not.toThrow()
  })
})

describe('fakeAsyncState', () => {
  test('inert defaults: idle status, no data, no error', () => {
    const s = fakeAsyncState<number>()
    expect(s.data.value).toBeUndefined()
    expect(s.error.value).toBeUndefined()
    expect(s.status.value).toBe('idle')
    expect(s.isLoading.value).toBe(false)
    expect(s.isFetching.value).toBe(false)
    expect(s.isStale.value).toBe(false)
    expect(s.lastUpdatedAt.value).toBeUndefined()
    expect(s.hasPendingMutations.value).toBe(false)
  })

  test('passing data flips status to success implicitly', () => {
    const s = fakeAsyncState<number>({ data: 42 })
    expect(s.data.value).toBe(42)
    expect(s.status.value).toBe('success')
  })

  test('explicit status override wins over data-based default', () => {
    const s = fakeAsyncState<number>({ data: 1, status: 'pending' })
    expect(s.status.value).toBe('pending')
  })

  test('all signal-backed overrides are read through', () => {
    const s = fakeAsyncState<string>({
      data: 'd',
      error: new Error('e'),
      status: 'error',
      isLoading: true,
      isFetching: true,
      isStale: true,
      lastUpdatedAt: 123,
      hasPendingMutations: true,
    })
    expect(s.data.value).toBe('d')
    expect((s.error.value as Error).message).toBe('e')
    expect(s.status.value).toBe('error')
    expect(s.isLoading.value).toBe(true)
    expect(s.isFetching.value).toBe(true)
    expect(s.isStale.value).toBe(true)
    expect(s.lastUpdatedAt.value).toBe(123)
    expect(s.hasPendingMutations.value).toBe(true)
  })

  test('default refetch / firstValue resolve to the current data; reset is a no-op', async () => {
    const s = fakeAsyncState<number>({ data: 7 })
    await expect(s.refetch()).resolves.toBe(7)
    await expect(s.firstValue()).resolves.toBe(7)
    expect(() => s.reset()).not.toThrow()
  })

  test('overrides for refetch / reset / firstValue are honored', async () => {
    const refetch = vi.fn(async () => 100)
    const reset = vi.fn()
    const firstValue = vi.fn(async () => 200)
    const s = fakeAsyncState<number>({ refetch, reset, firstValue })
    await expect(s.refetch()).resolves.toBe(100)
    await expect(s.firstValue()).resolves.toBe(200)
    s.reset()
    expect(reset).toHaveBeenCalled()
  })
})
