<script setup lang="ts">
import { onMounted } from 'vue'
import { type FrameworkId, framework, restoreFramework } from '../framework'

defineProps<{ name: FrameworkId }>()

onMounted(restoreFramework)
</script>

<template>
  <!-- v-show, not v-if: every framework stays in the HTML, so search and
       readers without JavaScript see all three. -->
  <div v-show="framework === name" class="for-framework">
    <slot />
  </div>
</template>
