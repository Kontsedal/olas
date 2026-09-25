import { olasPlugin } from '@kontsedal/olas-vue'
import { createApp } from 'vue'
import App from './App.vue'
import { createFakeTasksApi } from './api'
import { createAppRoot } from './root'
import './styles.css'

const api = createFakeTasksApi()
const root = createAppRoot(api)

createApp(App, { failNext: () => api.failNext() })
  .use(olasPlugin(root))
  .mount('#app')
