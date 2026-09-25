import { createRoot, defineController, required } from '@kontsedal/olas-core'
import { crossTabPlugin } from '@kontsedal/olas-cross-tab'
import { localStorageAdapter, usePersisted } from '@kontsedal/olas-persist'
import { addTodo, todosQuery } from './queries'

export const app = defineController((ctx) => {
  const draft = ctx.field('', [required()])
  const todos = ctx.use(todosQuery)
  const add = ctx.mutation({ ...addTodo, onSuccess: () => draft.reset() })
  const filter = ctx.form({ text: ctx.field('') })
  usePersisted(ctx, 'draft', draft, { storage: localStorageAdapter })
  return {
    draft,
    todos,
    add,
    filter,
    submit: () => add.run(draft.value),
    current: () => filter.value.value,
  }
})

export const root = createRoot(app, {
  deps: {},
  plugins: [crossTabPlugin({ channelName: 'todos' })],
  refetchOnWindowFocus: true,
})

export async function boot() {
  await root.todos.promise()
  root.__debug.subscribe(() => {})
  root.suspend({ maxIdle: 60_000 })
  const saved = await root.filter.submit(async () => root.current())
  return saved.ok
}
