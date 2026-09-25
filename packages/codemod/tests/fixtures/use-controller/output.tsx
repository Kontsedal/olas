import type { Root } from '@kontsedal/olas-core'
import { useRoot } from '@kontsedal/olas-react'

declare const root: Root<{ count: number }>
declare function pick(): Root<{ count: number }>

export function A() {
  const api = root.api
  return api.count + useRoot<{ count: number }>().count
}
export function B() {
  return pick().api.count
}
export function C() {
  return (root as Root<{ count: number }>).api.count + root.api.count
}
