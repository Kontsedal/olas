/**
 * An in-memory task server with latency, standing in for HTTP. Every call
 * takes an `AbortSignal`, as a `fetch` would, and `failNext()` makes the next
 * write reject, so the optimistic rollback can be seen in the app and pinned
 * in the tests.
 */
export type Task = { id: string; title: string; done: boolean }

export type TasksApi = {
  list(signal?: AbortSignal): Promise<Task[]>
  add(title: string, signal?: AbortSignal): Promise<Task>
  setDone(id: string, done: boolean, signal?: AbortSignal): Promise<Task>
}

export type FakeTasksApi = TasksApi & {
  /** The next `add` or `setDone` rejects, and the server state stays put. */
  failNext(): void
}

const SEED: Task[] = [
  { id: 't1', title: 'Read the Olas README', done: true },
  { id: 't2', title: 'Move data loading into a controller', done: false },
  { id: 't3', title: 'Test the controller without a renderer', done: false },
]

export function createFakeTasksApi(
  options: { latencyMs?: number; seed?: Task[] } = {},
): FakeTasksApi {
  const latency = options.latencyMs ?? 350
  let tasks = (options.seed ?? SEED).map((t) => ({ ...t }))
  let nextId = tasks.length + 1
  let failing = false

  const wait = (signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'))
        return
      }
      const timer = setTimeout(resolve, latency)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    })

  const takeFailure = () => {
    if (!failing) return
    failing = false
    throw new Error('The server rejected the change')
  }

  return {
    async list(signal) {
      await wait(signal)
      return tasks.map((t) => ({ ...t }))
    },
    async add(title, signal) {
      await wait(signal)
      takeFailure()
      const task = { id: `t${nextId++}`, title, done: false }
      tasks = [...tasks, task]
      return { ...task }
    },
    async setDone(id, done, signal) {
      await wait(signal)
      takeFailure()
      tasks = tasks.map((t) => (t.id === id ? { ...t, done } : t))
      const task = tasks.find((t) => t.id === id)
      if (task === undefined) throw new Error(`No task ${id}`)
      return { ...task }
    },
    failNext() {
      failing = true
    },
  }
}
