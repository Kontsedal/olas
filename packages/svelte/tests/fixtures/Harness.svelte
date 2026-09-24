<script lang="ts">
import type { Root } from '@kontsedal/olas-core'
import type { Component } from 'svelte'
import { setRoot } from '../../src'

let { root, view: View }: { root: Root<unknown>; view: Component } = $props()
// The root is read once, on purpose: a context is set while the component
// initializes, so a later change to the prop could not reach it anyway.
// svelte-ignore state_referenced_locally
setRoot(root)
</script>

<View />
