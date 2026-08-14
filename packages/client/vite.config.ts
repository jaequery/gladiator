import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    // Babylon is large and the sim is small; keeping the map lets the asset
    // budget in GLAD-PGS73O be measured rather than guessed.
    sourcemap: true,
    target: 'es2023',
  },
})
