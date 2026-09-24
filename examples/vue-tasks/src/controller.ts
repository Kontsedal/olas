/**
 * The whole app's state, with no Vue in it. The components in `src/components`
 * only read what this returns and call its actions, which is why
 * `tests/controller.test.ts` can check every behaviour without mounting
 * anything.
 */
import {
  bindQuery,
  computed,
  createField,
  createForm,
  createMutation,
  createQuery,
  defineController,
  defineQuery,
  maxLength,
  required,
  signal,
} from '@kontsedal/olas-core'
import type { Task, TasksApi } from './api'

declare module '@kontsedal/olas-core' {
  interface AmbientDeps {
    api: TasksApi
  }
}

export type Filter = 'all' | 'open' | 'done'

export const tasksQuery = defineQuery({
  id: 'tasks',
  key: () => [],
  fetcher: ({ signal, deps }): Promise<Task[]> => deps.api.list(signal),
  staleTime: 30_000,
})

export const appController = defineController((ctx) => {
  const tasks = createQuery(ctx, tasksQuery)
  const cache = bindQuery(ctx, tasksQuery)

  const filter = signal<Filter>('all')
  const visible = computed(() => {
    const all = tasks.data.value ?? []
    const f = filter.value
    return f === 'all' ? all : all.filter((t) => t.done === (f === 'done'))
  })
  const remaining = computed(() => (tasks.data.value ?? []).filter((t) => !t.done).length)

  // Optimistic: the checkbox flips at once. `cancel` first, so a refetch in
  // flight cannot land over the guess; return the snapshot, so a failure
  // rolls it back. A failed run keeps its error on `toggle.error`.
  const toggle = createMutation(ctx, {
    id: 'tasks/toggle',
    onMutate: ({ id, done }: { id: string; done: boolean }) => {
      cache.cancel()
      return cache.setData((prev) => prev?.map((t) => (t.id === id ? { ...t, done } : t)) ?? [])
    },
    mutate: ({ id, done }, { signal, deps }) => deps.api.setDone(id, done, signal),
  })

  const title = createField<string>(ctx, '', {
    validators: [required('Give the task a title'), maxLength(80, 'Keep it under 80 characters')],
  })
  const addForm = createForm(ctx, { title })

  // Not optimistic: the new task needs the server's id, so it is written into
  // the cache when the server answers.
  const add = createMutation(ctx, {
    id: 'tasks/add',
    mutate: (value: string, { signal, deps }) => deps.api.add(value, signal),
    onSuccess: (task) => {
      cache.write((prev) => [...(prev ?? []), task])
    },
  })

  const submitAdd = () =>
    addForm.submit(async (value) => {
      await add.run(value.title.trim())
      addForm.reset()
    })

  return {
    tasks,
    visible,
    remaining,
    filter,
    setFilter: (next: Filter) => filter.set(next),
    toggle,
    addForm,
    add,
    submitAdd,
  }
})
