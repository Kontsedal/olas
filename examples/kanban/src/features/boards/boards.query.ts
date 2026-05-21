/**
 * Board catalog query — used by the sidebar.
 *
 * `crossTab: true` lets a board-rename in another tab reach this tab's
 * sidebar without a refetch. The `queryId` is the routing key.
 */

import { defineQuery } from '@kontsedal/olas-core'
import type { BoardSummary } from '../../api'

export const boardsListQuery = defineQuery({
  queryId: 'boards.list',
  crossTab: true,
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.listBoards(signal),
  staleTime: 60_000,
})

/**
 * Users and labels — shared catalogs whose payloads are walked by the
 * `entitiesPlugin` for normalization. Cross-tab so a rename in one tab
 * propagates everywhere the entity is observed.
 */
export const usersQuery = defineQuery({
  queryId: 'users.list',
  crossTab: true,
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.listUsers(signal),
  staleTime: 5 * 60_000,
})

export const labelsQuery = defineQuery({
  queryId: 'labels.list',
  crossTab: true,
  key: () => [],
  fetcher: ({ signal, deps }) => deps.api.listLabels(signal),
  staleTime: 5 * 60_000,
})
