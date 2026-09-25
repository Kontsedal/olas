// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root as ReactRoot } from 'react-dom/client'
import { App } from './react-views'
import { runParity } from './scenarios'

// React 19 warns when `act` runs outside a test environment it recognises.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let reactRoot: ReactRoot | undefined
let container: HTMLElement | undefined

runParity({
  name: 'react',
  mount(view, root) {
    container = document.createElement('div')
    document.body.appendChild(container)
    const target = createRoot(container)
    reactRoot = target
    act(() => {
      target.render(<App view={view} root={root} />)
    })
    return container
  },
  unmount() {
    const target = reactRoot
    if (target !== undefined) act(() => target.unmount())
    reactRoot = undefined
    container?.remove()
    container = undefined
  },
  async settle() {
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve()
    })
  },
})
