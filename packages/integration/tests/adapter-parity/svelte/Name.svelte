<script lang="ts">
import { fieldStore, getRoot } from '@kontsedal/olas-svelte'
import type { NameApi } from '../scenarios'

const api = getRoot<NameApi>()
// A field is a writable store as it is, so it binds directly.
const name = api.name
const state = fieldStore(api.name)
</script>

<input data-testid="input" bind:value={$name} onblur={() => state.markTouched()} />
<p data-testid="state">{$state.errors.join(',')}|{$state.isDirty}|{$state.touched}</p>
