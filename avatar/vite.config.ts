import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // three + three-vrm are ~800 kB minified; splitting them buys nothing for a single-page sandbox.
    chunkSizeWarningLimit: 1024,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
