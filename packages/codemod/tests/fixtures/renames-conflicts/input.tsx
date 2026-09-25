import type { ReadSignal } from '@kontsedal/olas-core'
import { KeepAlive, SuspendOnUnmount, use } from '@kontsedal/olas-react'

declare const count: ReadSignal<number>

// `useValue` is taken here, so `use` stays as a local alias of it.
const useValue = 1
export const a = use(count) + useValue

// Both names imported already: `KeepAlive` goes, its uses move over.
export const View = () => (
  <KeepAlive controller={null}>
    <SuspendOnUnmount controller={null} />
  </KeepAlive>
)
