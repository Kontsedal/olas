// Client entry. Reads the dehydrated state injected by the server into
// `window.__OLAS_STATE__`, builds the root with `hydrate`, then calls
// `hydrateRoot` so React reuses the SSR-rendered DOM.

import type { DehydratedState } from '@olas/core'
import { hydrateRoot } from 'react-dom/client'
import { createFakeApi } from './api'
import { App } from './App'
import { createAppRoot } from './controller'
import './styles.css'

declare global {
  interface Window {
    __OLAS_STATE__: DehydratedState | null
  }
}

const state = window.__OLAS_STATE__ ?? undefined
const api = createFakeApi()
const root = createAppRoot({ api, analytics: { track: console.log } }, state)

const container = document.getElementById('app')
if (container === null) throw new Error('Missing #app element')

hydrateRoot(container, <App root={root} />)

window.addEventListener('beforeunload', () => root.dispose())
