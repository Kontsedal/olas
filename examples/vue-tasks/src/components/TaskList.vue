<script setup lang="ts">
import { useMutation, useRoot, useValue } from '@kontsedal/olas-vue'

const api = useRoot()
const tasks = useValue(api.visible)
const { mutate: toggle, error } = useMutation(api.toggle)
</script>

<template>
  <div>
    <ul v-if="tasks.length > 0" class="list">
      <li v-for="task in tasks" :key="task.id" class="row">
        <label class="task">
          <input
            type="checkbox"
            :checked="task.done"
            @change="toggle({ id: task.id, done: !task.done })"
          />
          <span>{{ task.title }}</span>
        </label>
      </li>
    </ul>
    <p v-else class="meta">Nothing here.</p>
    <p v-if="error !== undefined" class="meta error" role="alert">
      The server rejected the change, so the checkbox went back.
    </p>
  </div>
</template>

<style scoped>
.list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.row + .row {
  border-top: 1px solid var(--color-border);
}

.task {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  min-height: var(--control-lg);
  cursor: pointer;
}

/* A ticked box is a choice, so it takes the accent. */
.task input {
  accent-color: var(--color-accent);
}

.error {
  margin-top: var(--space-4);
  color: var(--color-danger);
}
</style>
