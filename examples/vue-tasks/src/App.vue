<script setup lang="ts">
import { useQuery, useRoot, useValue } from '@kontsedal/olas-vue'
import AddTask from './components/AddTask.vue'
import FilterBar from './components/FilterBar.vue'
import TaskList from './components/TaskList.vue'

const props = defineProps<{ failNext?: () => void }>()

const api = useRoot()
const { isLoading, isFetching, error } = useQuery(api.tasks)
const remaining = useValue(api.remaining)
</script>

<template>
  <main class="app">
    <header class="header">
      <h1 class="title">Tasks</h1>
      <p class="meta">Vue · a controller owns the data; components only read it</p>
    </header>

    <section class="surface">
      <AddTask />
      <FilterBar />
      <p v-if="isLoading" class="meta" role="status">Loading tasks…</p>
      <p v-else-if="error !== undefined" class="meta" role="alert">The tasks did not load.</p>
      <TaskList v-else />
      <footer class="footer">
        <p class="meta" aria-live="polite">
          {{ remaining }} open<span v-if="isFetching && !isLoading"> · refreshing</span>
        </p>
        <button v-if="props.failNext" type="button" class="control" @click="props.failNext()">
          Fail the next change
        </button>
      </footer>
    </section>
  </main>
</template>

<style scoped>
.app {
  max-width: 560px;
  margin: 0 auto;
  padding: var(--space-7) var(--space-6);
}

.header {
  margin-bottom: var(--space-6);
}

.title {
  margin: 0;
  font-size: var(--text-display);
  font-weight: var(--weight-semibold);
}

.surface {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-surface);
  background: var(--color-bg-elev);
}

.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding-top: var(--space-5);
  border-top: 1px solid var(--color-border);
}
</style>
