// @vitest-environment jsdom
// The real `App.vue`, mounted with the plugin and a fast fake server: the
// components read the controller and call its actions.
import { olasPlugin } from '@kontsedal/olas-vue'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp, nextTick, type App as VueApp } from 'vue'
import App from '../src/App.vue'
import { createFakeTasksApi } from '../src/api'
import { createAppRoot } from '../src/root'

let app: VueApp | undefined
const roots: Array<{ dispose(): void }> = []
afterEach(() => {
  app?.unmount()
  app = undefined
  for (const r of roots.splice(0)) r.dispose()
  document.body.innerHTML = ''
})

async function mountApp() {
  const api = createFakeTasksApi({ latencyMs: 0 })
  const root = createAppRoot(api)
  roots.push(root)
  const el = document.createElement('div')
  document.body.appendChild(el)
  app = createApp(App, { failNext: () => api.failNext() })
  app.use(olasPlugin(root))
  app.mount(el)
  await root.waitForIdle()
  await nextTick()
  return { el, root, api }
}

const settle = async (root: { waitForIdle(): Promise<void> }) => {
  await root.waitForIdle()
  await nextTick()
}

describe('App.vue', () => {
  test('renders the loaded tasks and the open count', async () => {
    const { el } = await mountApp()
    const titles = [...el.querySelectorAll('.task span')].map((s) => s.textContent)
    expect(titles).toEqual([
      'Read the Olas README',
      'Move data loading into a controller',
      'Test the controller without a renderer',
    ])
    expect(el.querySelector('footer')?.textContent).toContain('2 open')
  })

  test('adding a task through the form', async () => {
    const { el, root } = await mountApp()
    const input = el.querySelector('#new-task') as HTMLInputElement
    input.value = 'Ship 1.0'
    input.dispatchEvent(new Event('input'))
    ;(el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await settle(root)
    await settle(root)
    const titles = [...el.querySelectorAll('.task span')].map((s) => s.textContent)
    expect(titles).toContain('Ship 1.0')
    expect(input.value).toBe('')
  })

  test('an empty submit shows the validation message', async () => {
    const { el, root } = await mountApp()
    ;(el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'))
    await settle(root)
    expect(el.querySelector('#new-task-error')?.textContent).toContain('Give the task a title')
  })

  test('a rejected toggle puts the checkbox back and says why', async () => {
    const { el, root } = await mountApp()
    const failButton = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Fail the next change'),
    )
    failButton?.click()
    const box = el.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement
    expect(box.checked).toBe(false)
    box.click()
    await nextTick()
    await settle(root)
    expect((el.querySelectorAll('input[type="checkbox"]')[1] as HTMLInputElement).checked).toBe(
      false,
    )
    expect(el.textContent).toContain('The server rejected the change')
  })

  test('the filter shows only the chosen tasks', async () => {
    const { el } = await mountApp()
    const done = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Done')
    done?.click()
    await nextTick()
    const titles = [...el.querySelectorAll('.task span')].map((s) => s.textContent)
    expect(titles).toEqual(['Read the Olas README'])
    expect(done?.getAttribute('aria-pressed')).toBe('true')
  })
})
