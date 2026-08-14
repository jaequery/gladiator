import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tools/` is in here because the map baker is a program with rules in it —
    // "reject a spawn inside solid" is a behaviour, and a behaviour nobody
    // tests is a behaviour that stops happening.
    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.ts'],
    environment: 'node',
    // The simulation must not depend on globals it did not import; running the
    // suite without vitest's globals keeps the tests honest about that too.
    globals: false,
  },
})
