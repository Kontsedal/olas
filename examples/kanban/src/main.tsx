// Entry. Builds the root, renders React, cleans up on unload.

import { createRoot as createReactRoot } from 'react-dom/client'
import { createFakeApi } from './api'
import { createAppRoot } from './controller'
import './styles.css'
import { App } from './View/App'

const api = createFakeApi()
const root = createAppRoot(api, 'b1')

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app element')

createReactRoot(container).render(<App root={root} api={api} />)

window.addEventListener('beforeunload', () => root.dispose())
