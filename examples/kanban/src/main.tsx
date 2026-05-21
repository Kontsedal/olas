import { createRoot as createReactRoot } from 'react-dom/client'
import { App } from './App'
import { createAppRoot } from './root'
import './styles.css'

const { root, broadcaster } = createAppRoot()

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app element')

createReactRoot(container).render(<App root={root} />)

window.addEventListener('beforeunload', () => {
  root.dispose()
  broadcaster.dispose()
})
