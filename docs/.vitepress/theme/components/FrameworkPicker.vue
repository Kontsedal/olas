<script setup lang="ts">
import { onMounted, useId } from 'vue'
import { chooseFramework, framework, frameworks, restoreFramework } from '../framework'

// Every picker on a page shares one choice, and each needs its own radio
// group name so the browser does not merge two pickers into one group.
const group = useId()

onMounted(restoreFramework)
</script>

<template>
  <fieldset class="framework-picker">
    <legend class="visually-hidden">Show the code for</legend>
    <label v-for="f in frameworks" :key="f.id" :class="{ active: framework === f.id }">
      <input
        type="radio"
        :name="group"
        :value="f.id"
        :checked="framework === f.id"
        @change="chooseFramework(f.id)"
      />
      {{ f.label }}
    </label>
  </fieldset>
</template>

<style scoped>
.framework-picker {
  display: inline-flex;
  gap: 2px;
  margin: 16px 0 0;
  padding: 3px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-alt);
}

label {
  position: relative;
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--vp-c-text-2);
  cursor: pointer;
  transition: color 120ms, background-color 120ms;
}

label:hover {
  color: var(--vp-c-text-1);
}

label.active {
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  box-shadow: inset 0 0 0 1px var(--vp-c-divider);
}

input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

label:has(input:focus-visible) {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
