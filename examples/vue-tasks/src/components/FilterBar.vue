<script setup lang="ts">
import { useRoot, useValue } from '@kontsedal/olas-vue'
import type { Filter } from '../controller'

const api = useRoot()
const filter = useValue(api.filter)
const options: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
]
</script>

<template>
  <div class="filters" role="group" aria-label="Show">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="control filter"
      :aria-pressed="filter === option.value"
      @click="api.setFilter(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  gap: var(--space-2);
}

.filter {
  height: var(--control-sm);
  padding: 0 var(--space-4);
  border-color: transparent;
  background: transparent;
  color: var(--color-fg-mute);
}

/* The chosen filter is state, so it takes the accent's wash. */
.filter[aria-pressed="true"] {
  background: var(--color-accent-soft);
  color: var(--color-fg);
  font-weight: var(--weight-medium);
}
</style>
