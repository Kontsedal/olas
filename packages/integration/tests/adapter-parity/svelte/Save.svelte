<script lang="ts">
import { getRoot, mutationStore } from '@kontsedal/olas-svelte'
import type { SaveApi } from '../scenarios'

const save = mutationStore(getRoot<SaveApi>().save)
</script>

<p data-testid="save">{$save.status}|{$save.data ?? ''}</p>
<button type="button" data-testid="ok" onclick={() => save.mutate(21)}>ok</button>
<button type="button" data-testid="fail" onclick={() => save.mutate(-1)}>fail</button>
