import { defineEntity } from '@kontsedal/olas-entities'
import type { User } from '../api'

/**
 * `User` entity. The `idOf` predicate is the "is this object a User?" check
 * the plugin's auto-walk consults on every cache write. Keep it tight —
 * any object with `{ id, name, hue }` would otherwise be claimed.
 */
export const UserEntity = defineEntity<User>({
  name: 'User',
  idOf: (v) => {
    if (v === null || typeof v !== 'object') return null
    const o = v as Partial<User>
    if (typeof o.id !== 'string') return null
    if (!o.id.startsWith('u_')) return null
    if (typeof o.name !== 'string') return null
    if (typeof o.hue !== 'number') return null
    return o.id
  },
})
