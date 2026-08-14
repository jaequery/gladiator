import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    // The simulation must not depend on globals it did not import; running the
    // suite without vitest's globals keeps the tests honest about that too.
    globals: false,
  },
})
