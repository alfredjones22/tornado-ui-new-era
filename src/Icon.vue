<script setup lang="ts">
defineProps<{ name: string; size?: number }>()
const paths: Record<string, string> = {
  arrow: 'M7 17 17 7M7 7h10v10',
  down: 'm6 9 6 6 6-6',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M9 12l2 2 4-4',
  lock: 'M6 10h12v11H6z M8 10V7a4 4 0 0 1 8 0v3',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 2h4l1 3 3 1 3 4v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3 3-3Z',
  wallet: 'M20 8H5a2 2 0 0 1 0-4h13v4 M4 6v13h16V8 M16 12h4v3h-4z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', close: 'm6 6 12 12M6 18 18 6',
  info: 'M12 16v-5 M12 7v1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  file: 'M14 2H5v20h14V7l-5-5Z M14 2v6h5 M8 12h8M8 16h8',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  refresh: 'M20 7v5h-5M4 17v-5h5 M6 6a8 8 0 0 1 14 6M18 18a8 8 0 0 1-14-6',
  check: 'm5 12 4 4L19 6', layers: 'm12 3 10 6-10 6L2 9l10-6Zm-9 11 9 6 9-6',
  back: 'M19 12H5m6-6-6 6 6 6',
}
</script>
<template><svg :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.info" /></svg></template>
