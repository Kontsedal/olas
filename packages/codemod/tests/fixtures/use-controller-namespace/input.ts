import type { Root } from '@kontsedal/olas-core'
import * as OlasReact from '@kontsedal/olas-react'

declare const root: Root<{ count: number }>

export function A() {
  return OlasReact.useController(root).count + OlasReact.useRoot<{ count: number }>().count
}
export const hook = OlasReact.useController
export type Hook = typeof OlasReact.useController
