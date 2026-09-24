<script lang="ts">
import { getRoot } from '@kontsedal/olas-svelte'
import type { CounterApi } from '../scenarios'

const api = getRoot<CounterApi>()
const count = api.count
</script>

<button type="button" data-testid="count" onclick={api.inc}>{$count}</button>
