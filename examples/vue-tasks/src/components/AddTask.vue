<script setup lang="ts">
import { useField, useMutation, useRoot, useValue } from '@kontsedal/olas-vue'

const api = useRoot()
const { value, errors, touched, markTouched } = useField(api.addForm.fields.title)
const isSubmitting = useValue(api.addForm.isSubmitting)
const { error: addError } = useMutation(api.add)

async function onSubmit() {
  api.addForm.markAllTouched()
  await api.submitAdd()
}
</script>

<template>
  <form class="add" novalidate @submit.prevent="onSubmit">
    <label class="label" for="new-task">New task</label>
    <div class="row">
      <input
        id="new-task"
        v-model="value"
        class="control input"
        placeholder="What needs doing?"
        autocomplete="off"
        :aria-invalid="touched && errors.length > 0 ? true : undefined"
        aria-describedby="new-task-error"
        @blur="markTouched"
      />
      <button type="submit" class="control control--primary" :disabled="isSubmitting">
        {{ isSubmitting ? 'Adding…' : 'Add' }}
      </button>
    </div>
    <p id="new-task-error" class="meta error" role="alert">
      <template v-if="touched && errors.length > 0">{{ errors[0] }}</template>
      <template v-else-if="addError !== undefined">The task was not added. Try again.</template>
    </p>
  </form>
</template>

<style scoped>
.add {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.label {
  font-size: var(--text-meta);
  font-weight: var(--weight-medium);
}

.row {
  display: flex;
  gap: var(--space-4);
}

.input {
  flex: 1;
  min-width: 0;
  background: var(--color-bg-sunk);
}

.error {
  min-height: calc(var(--text-meta) * var(--font-line));
  color: var(--color-danger);
}
</style>
