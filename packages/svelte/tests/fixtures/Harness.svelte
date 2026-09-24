<script lang="ts">
import type { Root } from '@kontsedal/olas-core'
import type { Component } from 'svelte'
import { setRoot } from '../../src'

let { root, view: View }: { root: Root<unknown>; view: Component } = $props()
setRoot(root)
</script>

<View />
