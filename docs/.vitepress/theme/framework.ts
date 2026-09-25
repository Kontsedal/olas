import { ref } from 'vue'

export const frameworks = [
  { id: 'react', label: 'React' },
  { id: 'vue', label: 'Vue' },
  { id: 'svelte', label: 'Svelte' },
] as const

export type FrameworkId = (typeof frameworks)[number]['id']

const KEY = 'olas-docs-framework'

// One choice for the whole site, so a reader who picks Vue once sees Vue on
// every page. The server renders React, and the saved choice is read after
// mount, so the first client render matches the server HTML.
export const framework = ref<FrameworkId>('react')

let restored = false

export function restoreFramework(): void {
  if (restored) return
  restored = true
  try {
    const saved = localStorage.getItem(KEY)
    const match = frameworks.find((f) => f.id === saved)
    if (match !== undefined) framework.value = match.id
  } catch {
    // Storage can be blocked. The picker still works for this page view.
  }
}

export function chooseFramework(id: FrameworkId): void {
  framework.value = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // As above: the choice holds until the reader leaves the site.
  }
}
