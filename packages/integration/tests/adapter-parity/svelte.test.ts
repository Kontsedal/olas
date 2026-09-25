// The parity views for `@kontsedal/olas-svelte`, as Svelte 5 components. Runs
// in the `svelte` vitest project (compiler plugin, `browser` condition).
import { type Component, flushSync, mount, unmount } from 'svelte'
import { runParity, type ViewName } from './scenarios'
import App from './svelte/App.svelte'
import Counter from './svelte/Counter.svelte'
import Feed from './svelte/Feed.svelte'
import Name from './svelte/Name.svelte'
import Save from './svelte/Save.svelte'
import User from './svelte/User.svelte'

// A signal is a Svelte store as it is, with no `isEqual` to pass: the adapter
// has no `equal` view.
const VIEWS: Record<Exclude<ViewName, 'equal'>, Component> = {
  counter: Counter,
  user: User,
  feed: Feed,
  name: Name,
  save: Save,
}

let app: Record<string, unknown> | undefined
let container: HTMLElement | undefined

runParity({
  name: 'svelte',
  lacks: ['equal'],
  mount(view, root) {
    if (view === 'equal') throw new Error('the Svelte adapter has no isEqual option')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = mount(App, { target: container, props: { root, view: VIEWS[view] } })
    return container
  },
  unmount() {
    if (app !== undefined) unmount(app)
    app = undefined
    container?.remove()
    container = undefined
  },
  async settle() {
    for (let i = 0; i < 5; i++) await Promise.resolve()
    flushSync()
  },
})
