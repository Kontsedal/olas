import type { Root } from '@kontsedal/olas-core'
import { useController } from '@kontsedal/olas-react'

declare const root: Root<{ count: number }>

export const a = root.api
export const hook = useController
export const odd = (useController as (...args: unknown[]) => unknown)(root, root)
export const two = useController(root, root)
