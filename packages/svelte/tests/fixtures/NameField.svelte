<script lang="ts">
import type { Field } from '@kontsedal/olas-core'
import { fieldStore, getRoot } from '../../src'

const api = getRoot<{ name: Field<string> }>()
// A field is a writable store as it is, so it binds directly; `fieldStore`
// adds the validation state beside it.
const name = api.name
const state = fieldStore(api.name)
</script>

<input bind:value={$name} onblur={() => state.markTouched()} />
<p>{$state.errors.join(',')}|{$state.isDirty}|{$state.touched}</p>
