import { defineMutation, defineQuery } from '@kontsedal/olas-core'

export const todosQuery = defineQuery({
  queryId: 'todos',
  key: () => [],
  fetcher: async ({ signal }) => fetchTodos(signal),
  crossTab: true,
})

export const statsQuery = defineQuery({
  key: () => ['stats'],
  fetcher: async () => 3,
})

export const addTodo = defineMutation({
  mutationId: 'todos/add',
  mutate: async (title: string, signal) => post(title, signal),
})

declare function fetchTodos(signal: AbortSignal): Promise<string[]>
declare function post(title: string, signal: AbortSignal): Promise<string>
