// Entry point — wires the root to a React render. Not executed by CI; this
// file exists to show the canonical bootstrap.

import { createRoot as createReactRoot } from 'react-dom/client'
import { App } from './View'
import { createFakeApi } from './api'
import { createAppRoot } from './controller'

const api = createFakeApi()
const olasRoot = createAppRoot('1', api)

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app element')

createReactRoot(container).render(<App root={olasRoot} />)

// On HMR / page unload, dispose the root so timers and subscriptions are
// cleaned up. In a real app you'd let the page lifecycle handle this.
window.addEventListener('beforeunload', () => {
  olasRoot.dispose()
})
