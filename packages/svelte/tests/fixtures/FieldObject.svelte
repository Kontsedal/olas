<script lang="ts">
import type { Field } from '@kontsedal/olas-core'
import { fieldStore, getRoot } from '../../src'

type Person = { first: string; last: string }
const api = getRoot<{ person: Field<Person> }>()
// A nested bind: Svelte assigns `first` on the value object the store handed
// it, then passes the state object back to `set`.
const person = fieldStore(api.person)
</script>

<input bind:value={$person.value.first} />
<p>{$person.value.first}|{$person.isDirty}|{$person.errors.join(',')}</p>
