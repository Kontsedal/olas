// Fake API for the example. In a real app this would be a thin client around fetch.

export type User = {
  id: string
  name: string
  email: string
}

// Mutable in-memory store so the demo's mutations actually take effect.
const users = new Map<string, User>([
  ['1', { id: '1', name: 'Alice Doe', email: 'alice@example.com' }],
  ['2', { id: '2', name: 'Bob Stone', email: 'bob@example.com' }],
])

export type Api = {
  getUser(id: string, signal?: AbortSignal): Promise<User>
  updateUser(id: string, patch: Partial<Omit<User, 'id'>>, signal?: AbortSignal): Promise<User>
}

export function createFakeApi(): Api {
  return {
    async getUser(id, signal) {
      await delay(150, signal)
      const user = users.get(id)
      if (!user) throw new Error(`User ${id} not found`)
      return user
    },
    async updateUser(id, patch, signal) {
      await delay(300, signal)
      const prev = users.get(id)
      if (!prev) throw new Error(`User ${id} not found`)
      const next = { ...prev, ...patch }
      users.set(id, next)
      return next
    },
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const id = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(id)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })
}
