/**
 * Top-level controller.
 *
 * Responsibilities:
 *  - Create notifications + activity emitters; provide via scopes.
 *  - Build the preferences slice via `createPreferences(ctx)`; provide
 *    `preferencesScope`.
 *  - Seed shared queries (users / labels) so the entities plugin sees
 *    them and the assignee / label pickers have data.
 *  - Mount feature children in dependency order:
 *      boards → board → cardDetail → comments → activity → notifications → archive
 *  - Provide `activeBoardScope` (sourced from boardsController) AND
 *    `selectedCardScope` (sourced from boardController) so sibling feature
 *    controllers can inject them.
 *  - Bridge `notifyRef.current` so the root `onError` handler reaches the
 *    notifications emitter that lives inside this tree.
 */

import { type CtrlApi, type Ctx, defineController } from '@kontsedal/olas-core'
import { activityController } from './features/activity/activity.controller'
import { archiveController } from './features/archive/archive.controller'
import { boardController } from './features/board/board.controller'
import { boardsController } from './features/boards/boards.controller'
import { labelsQuery, usersQuery } from './features/boards/boards.query'
import { cardDetailController } from './features/card-detail/card-detail.controller'
import { commentsController } from './features/comments/comments.controller'
import { notificationsController } from './features/notifications/notifications.controller'
import { createPreferences } from './features/preferences/preferences.controller'
import type { ActivityEvent, NotificationEvent } from './scopes'
import {
  activeBoardScope,
  activityScope,
  notificationsScope,
  preferencesScope,
  selectedCardScope,
} from './scopes'

export const appController = defineController(
  (ctx: Ctx) => {
    // Notifications + activity emitters — provided to every descendant.
    const notifications = ctx.emitter<NotificationEvent>()
    ctx.provide(notificationsScope, notifications)
    const activity = ctx.emitter<ActivityEvent>()
    ctx.provide(activityScope, activity)

    // Preferences (theme/density/sidebar/…).
    const preferences = createPreferences(ctx)
    ctx.provide(preferencesScope, preferences)

    // Bridge the root-level `onError` to our notifications emitter.
    ctx.deps.notifyRef.current = (event) => notifications.emit(event)
    ctx.onDispose(() => {
      ctx.deps.notifyRef.current = () => {}
    })

    // Seed the entity stores by subscribing — the entities plugin's
    // auto-walk happens on every cache write, so subscribing here is enough.
    const users = ctx.use(usersQuery)
    const labels = ctx.use(labelsQuery)

    // Boards catalog.
    const boards = ctx.child(boardsController, undefined)
    ctx.provide(activeBoardScope, {
      activeBoardId: boards.activeBoardId,
      setActive: boards.setActive,
    })

    // Active-board feature.
    const board = ctx.child(boardController, undefined)
    ctx.provide(selectedCardScope, {
      selectedCardId: board.selectedCardId,
      open: board.openCard,
      close: board.closeCard,
    })

    // Detail / comments — depend on selectedCardScope.
    const cardDetail = ctx.child(cardDetailController, undefined)
    const comments = ctx.child(commentsController, undefined)

    // Cross-cutting feeds.
    const activityFeed = ctx.child(activityController, undefined)
    const notificationsView = ctx.child(notificationsController, undefined)
    const archive = ctx.child(archiveController, undefined)

    return {
      preferences,
      boards,
      board,
      cardDetail,
      comments,
      activity: activityFeed,
      notifications: notificationsView,
      archive,
      users,
      labels,
      // Pass-through to the entities plugin so React components can
      // synchronously look up a cached entity by id.
      entities: ctx.deps.entities,
    }
  },
  { name: 'app' },
)

export type AppApi = CtrlApi<typeof appController>
