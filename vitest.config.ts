import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
export default defineConfig({
  plugins: [vue()],
  test: {
    server: { deps: { inline: [/@kohaku-eth/] } },
    projects: [
      { extends: true, test: { name: 'core', include: ['tests/**/*.test.{ts,js}'], exclude: ['tests/*-ui.test.ts'] } },
      { extends: true, test: { name: 'ui', include: ['tests/*-ui.test.ts'], environment: './tests/fixtures/vue-environment.ts' } },
    ],
  },
})
