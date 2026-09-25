import { createRoot, defineController } from '@kontsedal/olas-core'
import { defineEntity, type EntitiesPlugin, entitiesPlugin } from '@kontsedal/olas-entities'

const Post = defineEntity<{ id: string }>({ name: 'post', idOf: (p) => p.id })
const all = [Post]

export const store = entitiesPlugin({ entities: [Post] })
export const fromList = entitiesPlugin({ entities: all })
export const already = entitiesPlugin({ entities: [Post] })
export const missing = entitiesPlugin()

export function refresh(entities: EntitiesPlugin) {
  entities.remove(Post, 'p1')
  entities.update(Post, 'p1', { id: 'p2' })
  return entities.signal(Post, 'p1')
}

const app = defineController(() => ({}))
createRoot(app, { deps: {}, plugins: [store] })

// The plugin's own members, and other objects: left alone.
export const pluginName = store.name
declare const unrelated: { invalidate(): void }
unrelated.invalidate()
