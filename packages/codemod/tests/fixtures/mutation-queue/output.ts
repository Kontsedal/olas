import { mutationQueuePlugin } from '@kontsedal/olas-mutation-queue'
import { localStorageAdapter } from '@kontsedal/olas-persist'

const adapter = localStorageAdapter

export const queue = mutationQueuePlugin({ storage: localStorageAdapter, keyPrefix: 'q/' })
export const settling = mutationQueuePlugin({
  storage: adapter,
  keyPrefix: 'q/',
  onReplaySettle: (entry, result, api) => api.invalidate(entry),
})
export const quiet = mutationQueuePlugin({
  storage: adapter,
  keyPrefix: 'q/',
  onReplaySettle(entry) {
    void entry
  },
})

const options = { adapter, keyPrefix: 'q/' }
export const fromVariable = mutationQueuePlugin(options)
const renamed = { storage: adapter, keyPrefix: 'q/' }
export const fromRenamed = mutationQueuePlugin(renamed)
export const bare = mutationQueuePlugin()

export async function replay() {
  await queue.replayNow()
}

// Not the queue plugin: left alone.
declare const other: { replayNow(): void }
other.replayNow()
