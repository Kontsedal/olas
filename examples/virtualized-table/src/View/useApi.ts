import { useRoot } from '@kontsedal/olas-react'
import type { AppApi } from '../app'

export function useApi(): AppApi {
  return useRoot<AppApi>()
}
