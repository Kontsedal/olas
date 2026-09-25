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

  test('isValid derives from errors when not explicitly overridden', () => {
    const f = fakeField('x', { errors: ['bad'] })
    expect(f.isValid.value).toBe(false)
  })

  test('isValid holds its settled value while validating, as a real field does', () => {
    // A real field has no settled pass before its first check ends, and that
    // reads valid (spec §8.2), so a validating fake reads valid too.
    const g = fakeField('x', { isValidating: true })
    expect(g.isValid.value).toBe(true)
    const h = fakeField('x', { isValidating: true, errors: ['bad'] })
    expect(h.isValid.value).toBe(true)
  })

  test('reset() restores the initial value and clears dirty, touched and errors', () => {
    const f = fakeField<string>('a', { errors: ['bad'], touched: true, isValidating: true })
    f.set('b')
    f.setErrors(['server'])
    f.reset()
    expect(f.value).toBe('a')
    expect(f.isDirty.value).toBe(false)
    expect(f.touched.value).toBe(false)
    expect(f.errors.value).toEqual([])
    expect(f.isValidating.value).toBe(false)
  })

  test('setErrors is a separate server channel that the next set() clears', () => {
    const f = fakeField<string>('a', { errors: ['validator'] })
    f.setErrors(['server'])
    expect(f.errors.value).toEqual(['validator', 'server'])
    f.set('b')
    expect(f.errors.value).toEqual(['validator'])
    f.setErrors(['server'])
    f.setErrors([])
    expect(f.errors.value).toEqual(['validator'])
  })

  test('set() marks the field dirty, and setting it back to the initial clears it', () => {
    const f = fakeField<{ n: number }>({ n: 1 })
    f.set({ n: 2 })
    expect(f.isDirty.value).toBe(true)
    f.set({ n: 1 })
    expect(f.isDirty.value).toBe(false)
  })

  test('setAsInitial clears server errors', () => {
    const f = fakeField<string>('a')
    f.setErrors(['server'])
    f.setAsInitial('b')
    expect(f.errors.value).toEqual([])
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

  test('an in-place edit of the value does not reach what reset() restores', () => {
    const f = fakeField<{ first: string }>({ first: 'Ada' })
    f.peek().first = 'Grace'
    f.set(f.peek())
    f.reset()
    expect(f.value).toEqual({ first: 'Ada' })

    f.setAsInitial({ first: 'Alan' })
    f.peek().first = 'Edsger'
    f.reset()
    expect(f.value).toEqual({ first: 'Alan' })
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

  test('an error without a status reads as status error; firstValue rejects with it', async () => {
    const boom = new Error('boom')
    const s = fakeAsyncState<number>({ error: boom })
    expect(s.status.value).toBe('error')
    await expect(s.firstValue()).rejects.toBe(boom)
  })

  test('firstValue resolves with the data after a failed refetch, as the real one does', async () => {
    const s = fakeAsyncState<number>({ data: 3, error: new Error('refetch failed') })
    expect(s.status.value).toBe('error')
    await expect(s.firstValue()).resolves.toBe(3)
  })

  test('a pending status with no data reads as loading and fetching', () => {
    const s = fakeAsyncState<number>({ status: 'pending' })
    expect(s.isLoading.value).toBe(true)
    expect(s.isFetching.value).toBe(true)
    const refetching = fakeAsyncState<number>({ status: 'pending', data: 1 })
    expect(refetching.isLoading.value).toBe(false)
    expect(refetching.isFetching.value).toBe(true)
  })

  test('firstValue waits while there is no data, as a real subscription does', async () => {
    const s = fakeAsyncState<number>()
    const settled = await Promise.race([
      s.firstValue().then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])
    expect(settled).toBe('pending')
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
