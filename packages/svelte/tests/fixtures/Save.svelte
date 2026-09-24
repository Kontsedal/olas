<script lang="ts">
import type { Mutation } from '@kontsedal/olas-core'
import { getRoot, mutationStore } from '../../src'

const api = getRoot<{ save: Mutation<number, number> }>()
const save = mutationStore(api.save)
</script>

<p>{$save.status}|{$save.data ?? ''}|{$save.isPending}</p>
<button onclick={() => save.mutate(21)}>ok</button>
<button onclick={() => save.mutate(-1)}>fail</button>
