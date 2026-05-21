import { defineEntity } from '@kontsedal/olas-entities'
import type { Label } from '../api'

export const LabelEntity = defineEntity<Label>({
  name: 'Label',
  idOf: (v) => {
    if (v === null || typeof v !== 'object') return null
    const o = v as Partial<Label>
    if (typeof o.id !== 'string') return null
    if (!o.id.startsWith('l_')) return null
    if (typeof o.name !== 'string') return null
    if (typeof o.hue !== 'number') return null
    return o.id
  },
})
