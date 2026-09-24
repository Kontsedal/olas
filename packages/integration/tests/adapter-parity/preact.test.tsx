// @vitest-environment jsdom
// The React views and `@kontsedal/olas-react`, with `react` aliased to
// `preact/compat` the way a Preact app configures its bundler. preact renders;
// React's renderer never loads.
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { vi } from 'vitest'
import { App } from './react-views'
import { runParity } from './scenarios'

vi.mock('react', async () => {
  const compat = await import('preact/compat')
  return { ...compat, default: compat.default }
})
vi.mock('react/jsx-runtime', async () => await import('preact/compat/jsx-runtime'))
vi.mock('react/jsx-dev-runtime', async () => await import('preact/compat/jsx-dev-runtime'))

let container: HTMLElement | undefined

runParity({
  name: 'preact',
  mount(view, root) {
    const target = document.createElement('div')
    container = target
    document.body.appendChild(target)
    act(() => {
      render(<App view={view} root={root} />, target)
    })
    return target
  },
  unmount() {
    const target = container
    if (target !== undefined) act(() => render(null, target))
    target?.remove()
    container = undefined
  },
  async settle() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
  },
})
