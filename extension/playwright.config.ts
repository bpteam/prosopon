import { defineConfig } from '@playwright/test';

// Extension tests launch their own persistent Chromium (see tests/e2e/extension.ts); no dev server.
// Run `npm run test:e2e`, which builds dist/ in development mode first (E2E hooks exist only there).
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One Chromium per test, each with its own offscreen audio: keep it sequential and deterministic.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
});
