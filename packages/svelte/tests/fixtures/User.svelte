<script lang="ts">
import type { AsyncState } from '@kontsedal/olas-core'
import { getRoot, queryStore } from '../../src'

const api = getRoot<{ user: AsyncState<string> }>()
const user = queryStore(api.user)
</script>

<p>{$user.isLoading ? 'loading' : ($user.data ?? '')}</p>
<button onclick={() => user.refetch()}>refetch</button>
