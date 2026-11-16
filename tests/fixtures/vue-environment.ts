import type { Environment } from 'vitest/runtime'

// Compile SFCs for client rendering while using the test's in-memory Vue host.
export default { name: 'vue-renderer', viteEnvironment: 'client', setup: () => ({ teardown() {} }) } satisfies Environment
