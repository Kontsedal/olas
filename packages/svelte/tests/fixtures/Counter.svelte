<script lang="ts">
import type { ReadSignal } from '@kontsedal/olas-core'
import { getRoot } from '../../src'

const api = getRoot<{ count: ReadSignal<number>; inc: () => void }>()
const count = api.count
</script>

<button onclick={api.inc}>{$count}</button>
