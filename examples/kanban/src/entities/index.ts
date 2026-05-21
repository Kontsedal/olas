import { type EntitiesPlugin, entitiesPlugin } from '@kontsedal/olas-entities'
import { LabelEntity } from './label.entity'
import { UserEntity } from './user.entity'

export type { EntitiesPlugin }
export { LabelEntity, UserEntity }

/** Build a fresh entities plugin for a root. Must not be shared across roots. */
export function createEntitiesPlugin(): EntitiesPlugin {
  return entitiesPlugin([UserEntity, LabelEntity])
}
