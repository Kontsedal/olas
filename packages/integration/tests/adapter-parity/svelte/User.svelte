<script lang="ts">
import { getRoot, queryStore } from '@kontsedal/olas-svelte'
import type { UserApi } from '../scenarios'

const user = queryStore(getRoot<UserApi>().user)
</script>

<p data-testid="user">{$user.isLoading ? 'loading' : ($user.data ?? '')}</p>
<button type="button" data-testid="refetch" onclick={() => void user.refetch()}>refetch</button>
