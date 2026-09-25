// Controller tests for the Vue tasks example. Plain Node, no DOM and no Vue:
// everything the app does lives in the controller, so it tests without a
// renderer. `createTestController` builds an isolated root around it.
import { createTestController } from '@kontsedal/olas-core/testing'
import { describe, expect, test } from 'vitest'
import { createFakeTasksApi } from '../src/api'
import { appController } from '../src/controller'

const setup = () => {
  const api = createFakeTasksApi({
    latencyMs: 0,
    seed: [
      { id: 'a', title: 'First', done: false },
      { id: 'b', title: 'Second', done: true },
    ],
  })
  const root = createTestController(appController, { deps: { api } })
  return { api, root, app: root.api }
}

describe('appController', () => {
  test('loads the tasks and counts the open ones', async () => {
    const { root, app } = setup()
    expect(app.tasks.isLoading.value).toBe(true)
    await root.waitForIdle()
    expect(app.visible.value.map((t) => t.title)).toEqual(['First', 'Second'])
    expect(app.remaining.value).toBe(1)
    root.dispose()
  })

  test('the filter narrows what is visible', async () => {
    const { root, app } = setup()
    await root.waitForIdle()
    app.setFilter('done')
    expect(app.visible.value.map((t) => t.id)).toEqual(['b'])
    app.setFilter('open')
    expect(app.visible.value.map((t) => t.id)).toEqual(['a'])
    root.dispose()
  })

  test('a toggle shows at once, and the server confirms it', async () => {
    const { api, root, app } = setup()
    await root.waitForIdle()
    const run = app.toggle.run({ id: 'a', done: true })
    // Optimistic: the cache already holds the guess.
    expect(app.remaining.value).toBe(0)
    expect(app.tasks.hasPendingMutations.value).toBe(true)
    await run
    expect(app.tasks.hasPendingMutations.value).toBe(false)
    expect((await api.list()).find((t) => t.id === 'a')?.done).toBe(true)
    root.dispose()
  })

  test('a rejected toggle rolls the guess back and keeps the error', async () => {
    const { api, root, app } = setup()
    await root.waitForIdle()
    api.failNext()
    const run = app.toggle.run({ id: 'a', done: true })
    expect(app.remaining.value).toBe(0)
    await expect(run).rejects.toThrow('rejected')
    expect(app.remaining.value).toBe(1)
    expect(app.toggle.error.value).toBeInstanceOf(Error)
    root.dispose()
  })

  test('adding validates the title, then writes the server task into the cache', async () => {
    const { root, app } = setup()
    await root.waitForIdle()
    const blocked = await app.submitAdd()
    expect(blocked).toMatchObject({ ok: false, reason: 'invalid' })
    expect(app.addForm.fields.title.errors.value).toEqual(['Give the task a title'])

    app.addForm.fields.title.set('  Third  ')
    const added = await app.submitAdd()
    expect(added.ok).toBe(true)
    expect(app.visible.value.map((t) => t.title)).toEqual(['First', 'Second', 'Third'])
    // The form resets for the next task.
    expect(app.addForm.fields.title.value).toBe('')
    root.dispose()
  })

  test('a title over 80 characters is refused', async () => {
    const { root, app } = setup()
    await root.waitForIdle()
    app.addForm.fields.title.set('x'.repeat(81))
    expect(app.addForm.fields.title.errors.value).toEqual(['Keep it under 80 characters'])
    root.dispose()
  })
})
