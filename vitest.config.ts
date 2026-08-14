import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `tools/` is in here because the map baker is a program with rules in it —
    // "reject a spawn inside solid" is a behaviour, and a behaviour nobody
    // tests is a behaviour that stops happening.
    //
    // `maps/` is in here because an arena has assertions of its own that are
    // about *this* map rather than about the format: that every ledge is on a
    // route the movement can take, that the spawns cannot see each other, that
    // it is the right size. `tools/bake-map.ts` already skips `*.test.ts` when
    // it looks for maps, so a test can sit beside the map it is about.
    include: ['packages/*/src/**/*.test.ts', 'tools/**/*.test.ts', 'maps/**/*.test.ts'],
    environment: 'node',
    // The simulation must not depend on globals it did not import; running the
    // suite without vitest's globals keeps the tests honest about that too.
    globals: false,
  },
})
