import { entitiesPlugin } from '@kontsedal/olas-entities'
import { LabelEntity } from './label.entity'
import { UserEntity } from './user.entity'

export { LabelEntity, UserEntity }

/**
 * The app's entity store. A plugin is a definition — each root that installs
 * it gets its own store — so one module-level value serves every root,
 * including the pairs of roots the cross-tab tests build. Controllers reach
 * the store with `ctx.inject(Entities)`.
 */
export const kanbanEntities = entitiesPlugin({ entities: [UserEntity, LabelEntity] })
