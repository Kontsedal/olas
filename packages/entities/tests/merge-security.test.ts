/**
 * A deep-merge patch parsed from JSON can carry an own `__proto__` key. The
 * merge must copy it as data, never let it replace the entity's prototype.
 */
import { createRoot, defineController, queryEngine } from '@kontsedal/olas-core'
import { describe, expect, test } from 'vitest'
import { defineEntity, Entities, type EntityStore, entitiesPlugin } from '../src'

type User = { id: string; name: string; settings: Record<string, unknown> }
const User = defineEntity<User>({
  name: 'SecUser',
  idOf: (v) =>
    v !== null && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string'
      ? (v as { id: string }).id
      : null,
})

describe("entities.update(…, { merge: 'deep' }) with a __proto__ key", () => {
  test('the key stays data, and the entity and its nested objects keep Object.prototype', () => {
    const root = createRoot(
      defineController(() => ({})),
      {
        queries: queryEngine(),
        deps: {},
        plugins: [entitiesPlugin({ entities: [User] })],
      },
    )
    const entities = root.inject(Entities) as EntityStore
    entities.upsert(User, { id: 'u1', name: 'Ada', settings: { theme: 'dark' } })
    const patch = JSON.parse(
      '{"__proto__":{"isAdmin":true},"settings":{"__proto__":{"beta":true},"font":"mono"}}',
    )
    entities.update(User, 'u1', patch, { merge: 'deep' })
    const user = entities.get(User, 'u1') as User & { isAdmin?: unknown }
    expect(Object.getPrototypeOf(user)).toBe(Object.prototype)
    expect(user.isAdmin).toBeUndefined()
    expect(Object.getPrototypeOf(user.settings)).toBe(Object.prototype)
    expect(user.settings.beta).toBeUndefined()
    expect(user.settings).toMatchObject({ theme: 'dark', font: 'mono' })
    root.dispose()
  })
})
