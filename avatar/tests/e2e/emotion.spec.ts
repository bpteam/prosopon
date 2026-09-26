import { expect, test } from '@playwright/test';

/**
 * US-006 calibration bench in the sandbox: whatever the Lip Sync folder plays goes through the feature worklet and
 * ProsodyEmotionAnalyzer into the real BehaviorMixer. Here the built-in test signal stands in for a recorded
 * ChatGPT answer.
 */
test('test signal → assistant emotion → face/body mix; lip sync still drives the mouth; silence decays', async ({ page }) => {
  // Headless rAF runs at a few Hz with capped deltas, so avatar time is slower than wall time here.
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/?analyzer=none');
  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'true');
  await expect(page.getByTestId('emotion-panel')).toBeVisible();

  await page.evaluate(() => window.__AVATAR_DEBUG__!.audio.startTestSignal());
  await expect
    .poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.emotion.value.assistant.active), { timeout: 10_000 })
    .toBe(true);
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.controller.emotionMix.assistant)).toBeGreaterThan(0.1);
  expect(await page.evaluate(() => window.__AVATAR_DEBUG__!.state)).toBe('speaking');
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.avatar!.getProcedural().aa)).toBeGreaterThan(0.05);
  expect(await page.evaluate(() => window.__AVATAR_DEBUG__!.emotion.value.user.confidence)).toBe(0);

  await page.evaluate(() => window.__AVATAR_DEBUG__!.audio.stop());
  await expect
    .poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.controller.emotionMix.assistant), { timeout: 60_000 })
    .toBeLessThan(0.02);
  expect(errors).toEqual([]);
});
