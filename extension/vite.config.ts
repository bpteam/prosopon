import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit tests only. The extension itself is built by scripts/build.mjs (two builds with different formats).
export default defineConfig({
  resolve: {
    alias: { '@avatar': resolve(import.meta.dirname, '../avatar/src') },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
