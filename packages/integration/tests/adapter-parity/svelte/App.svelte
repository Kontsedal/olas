<script lang="ts">
import type { Root } from '@kontsedal/olas-core'
import { setRoot } from '@kontsedal/olas-svelte'
import type { Component } from 'svelte'

let { root, view: View }: { root: Root<unknown>; view: Component } = $props()
setRoot(root)
</script>

<View />
