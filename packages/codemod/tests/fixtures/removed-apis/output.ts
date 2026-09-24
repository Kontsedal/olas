import {
  isStandardSchema,
  lookupRegisteredMutation,
  lookupRegisteredQuery,
  type QueryClientPlugin,
  signal,
  stableHash,
} from '@kontsedal/olas-core'
import type {
  ErrorContextInput,
  GcEvent,
  InvalidateEvent,
  MutationEnqueueEvent,
  MutationSettleEvent,
  QueryClientPluginApi,
  RegisteredMutation,
  RegisteredQuery,
  SetDataEvent,
} from '@kontsedal/olas-core'
import { use } from '@kontsedal/olas-react'
import { stableHash as hashFromElsewhere } from './local-helpers'

export const used = [
  isStandardSchema,
  lookupRegisteredMutation,
  lookupRegisteredQuery,
  signal,
  stableHash,
  use,
  hashFromElsewhere,
]
export type Used = [
  QueryClientPlugin,
  ErrorContextInput,
  GcEvent,
  InvalidateEvent,
  MutationEnqueueEvent,
  MutationSettleEvent,
  QueryClientPluginApi,
  RegisteredMutation,
  RegisteredQuery,
  SetDataEvent,
]
