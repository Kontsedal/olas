import { createRoot, defineController, required, createField, createForm, createMutation, createQuery, queryEngine } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { localStorageAdapter, createPersisted } from '@kontsedal/olas-persist'
import { addTodo, todosQuery } from './queries'

export const app = defineController((ctx) => {
  const draft = createField(ctx, '', { validators: [required()] })
  const todos = createQuery(ctx, todosQuery)
  const add = createMutation(ctx, addTodo, { onSuccess: () => draft.reset() })
  const filter = createForm(ctx, { text: createField(ctx, '') })
  createPersisted(ctx, 'draft', draft, { storage: localStorageAdapter() })
  return {
    draft,
    todos,
    add,
    filter,
    submit: () => add.run(draft.value),
    current: () => filter.value,
  }
})

export const root = createRoot(app, {
  deps: {},
  plugins: [crossTabPlugin({ channelName: 'todos' })],
  queries: queryEngine({ defaults: { refetchOnWindowFocus: true } }),
})

export async function boot() {
  await root.api.todos.firstValue()
  root.debug.subscribe(() => {})
  root.suspend({ maxIdleTime: 60_000 })
  const saved = await root.api.filter.submit(async () => root.api.current())
  return saved.ok
}
