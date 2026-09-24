import { defineMutation, defineQuery } from '@kontsedal/olas-core'

export const todosQuery = defineQuery({
  id: 'todos',
  key: () => [],
  fetcher: async ({ signal }) => fetchTodos(signal),
  meta: { crossTab: true },
})

export const statsQuery = defineQuery({
  id: 'src/queries.ts:10',
  key: () => ['stats'],
  fetcher: async () => 3,
})

export const addTodo = defineMutation({
  id: 'todos/add',
  mutate: async (title: string, { signal }) => post(title, signal),
  meta: { persist: true },
})

declare function fetchTodos(signal: AbortSignal): Promise<string[]>
declare function post(title: string, signal: AbortSignal): Promise<string>
