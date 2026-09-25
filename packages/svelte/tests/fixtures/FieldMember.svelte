<script lang="ts">
import type { Field } from '@kontsedal/olas-core'
import { fieldStore, getRoot } from '../../src'

const api = getRoot<{ name: Field<string> }>()
// One store for the input and its state: the binding writes a member of the
// store's value, which Svelte hands back to `set` whole.
const name = fieldStore(api.name)
</script>

<input bind:value={$name.value} />
<p>{$name.value}|{$name.isDirty}</p>
