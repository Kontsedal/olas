import type { Root } from '@kontsedal/olas-core'
import { useController, useRoot } from '@kontsedal/olas-react'
import { useController as controllerOf } from '@kontsedal/olas-react'

declare const root: Root<{ count: number }>
declare function pick(): Root<{ count: number }>

export function A() {
  const api = useController(root)
  return api.count + useRoot<{ count: number }>().count
}
export function B() {
  return useController(pick()).count
}
export function C() {
  return useController(root as Root<{ count: number }>).count + controllerOf(root).count
}
