import { describe, expect, test, vi } from 'vitest'
import { createEmitter } from '../src/emitter'

describe('createEmitter', () => {
  test('emit fires every subscribed handler with the value', () => {
    const e = createEmitter<{ id: string }>()
    const h1 = vi.fn()
    const h2 = vi.fn()
    e.on(h1)
    e.on(h2)
    e.emit({ id: 'a' })
    expect(h1).toHaveBeenCalledWith({ id: 'a' })
    expect(h2).toHaveBeenCalledWith({ id: 'a' })
  })

  test('on returns an unsubscribe function', () => {
    const e = createEmitter<number>()
    const handler = vi.fn()
    const off = e.on(handler)
    e.emit(1)
    off()
    e.emit(2)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(1)
  })

  test('once unsubscribes after the first emission', () => {
    const e = createEmitter<string>()
    const handler = vi.fn()
    e.once(handler)
    e.emit('a')
    e.emit('b')
    e.emit('c')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('a')
  })

  test('handlers added during emit do NOT fire for the in-progress emit', () => {
    const e = createEmitter<number>()
    const seen: string[] = []
    e.on(() => {
      seen.push('first')
      e.on(() => {
        seen.push('added-mid-emit')
      })
    })
    e.emit(1)
    expect(seen).toEqual(['first'])
    e.emit(2)
    // The dynamically-added handler runs from the second emit onward.
    expect(seen).toEqual(['first', 'first', 'added-mid-emit'])
  })

  test('a handler unsubscribing itself or others does not throw', () => {
    const e = createEmitter<number>()
    const h1Calls: number[] = []
    const h2Calls: number[] = []
    let off2 = () => {}
    const off1 = e.on((v) => {
      h1Calls.push(v)
      off2()
    })
    off2 = e.on((v) => {
      h2Calls.push(v)
    })
    e.emit(1)
    // h2 was unsubscribed but was already in the snapshot for this emit.
    expect(h1Calls).toEqual([1])
    expect(h2Calls).toEqual([1])

    e.emit(2)
    expect(h1Calls).toEqual([1, 2])
    expect(h2Calls).toEqual([1]) // gone now
    off1()
  })

  test('dispose drops all handlers; subsequent emits are no-ops', () => {
    const e = createEmitter<void>()
    const handler = vi.fn()
    e.on(handler)
    e.dispose()
    e.emit()
    expect(handler).not.toHaveBeenCalled()
  })

  test('dispose is idempotent', () => {
    const e = createEmitter<void>()
    expect(() => {
      e.dispose()
      e.dispose()
    }).not.toThrow()
  })

  test('void emitter has zero-arg emit', () => {
    const e = createEmitter()
    const handler = vi.fn()
    e.on(handler)
    e.emit()
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
