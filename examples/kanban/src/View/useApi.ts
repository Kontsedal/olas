// Tiny convenience: typed `useRoot()` so view components don't repeat the
// `useRoot<AppApi>()` annotation everywhere.

import { useRoot } from '@kontsedal/olas-react'
import type { AppApi } from '../app'

export function useApi(): AppApi {
  return useRoot<AppApi>()
}
