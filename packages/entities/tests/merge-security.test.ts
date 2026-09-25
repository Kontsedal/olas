/**
 * A deep-merge patch parsed from JSON can carry an own `__proto__` key. The
 * merge must copy it as data, never let it replace the entity's prototype.
 * The same holds for query data a backprop rebuilds.
 */
import {
  createQuery,
  createRoot,
  defineController,
  defineQuery,
  queryEngine,
} from '@kontsedal/olas-core'
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

describe('a backprop into query data with an own __proto__ key', () => {
  test('rebuilds the object with the key as data, and keeps Object.prototype', async () => {
    // A key parsed from JSON: an own property named `__proto__`, holding the entity.
    const q = defineQuery({
      id: 'ent-sec/proto-key',
      key: () => [],
      fetcher: async () =>
        JSON.parse('{"__proto__":{"id":"u1","name":"Ada","settings":{}}}') as Record<
          string,
          unknown
        >,
      staleTime: 60_000,
    })
    const root = createRoot(
      defineController((ctx) => ({ q: createQuery(ctx, q, () => []) })),
      { queries: queryEngine(), deps: {}, plugins: [entitiesPlugin({ entities: [User] })] },
    )
    const entities = root.inject(Entities) as EntityStore
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    expect(entities.get(User, 'u1')?.name).toBe('Ada')

    entities.update(User, 'u1', { name: 'Ada L' })
    const data = root.api.q.data.peek() as Record<string, unknown>
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
    expect(Object.hasOwn(data, '__proto__')).toBe(true)
    expect(
      (Object.getOwnPropertyDescriptor(data, '__proto__')?.value as User | undefined)?.name,
    ).toBe('Ada L')
    root.dispose()
  })
})
