import { createRoot as createReactRoot } from 'react-dom/client'
import { createFakeApi } from './api'
import { createAppRoot } from './app'
import './styles.css'
import { App } from './View/App'

const ROW_COUNT = 50_000
const api = createFakeApi()
const root = createAppRoot(api, ROW_COUNT)

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app element')

createReactRoot(container).render(<App root={root} />)

window.addEventListener('beforeunload', () => root.dispose())
