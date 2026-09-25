import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()} ${msg.location().url}`);
  });
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
  return errors;
}

test('sandbox loads and renders the VRM avatar', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');

  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'true');

  const canvas = page.locator('#stage canvas');
  await expect(canvas).toHaveCount(1);
  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(0);

  // lil-gui panel with the expected sections
  const gui = page.getByTestId('debug-panel');
  await expect(gui).toBeVisible();
  for (const folder of ['Head', 'Face', 'Blink', 'Mouth', 'Avatar', 'Idle']) {
    await expect(gui.locator('.lil-title', { hasText: new RegExp(`^${folder}$`) })).toHaveCount(1);
  }

  await expect(page.getByTestId('debug-overlay')).toContainText('VRM loaded  yes');
  await expect(page.getByTestId('debug-overlay')).toContainText('VRM version 1.0');

  expect(errors).toEqual([]);
});

test('debug API exposes state and the render loop is running', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'true');

  const state = await page.evaluate(() => {
    const api = window.__AVATAR_DEBUG__!;
    const avatar = api.avatar!;
    return {
      loaded: api.loaded,
      version: avatar.vrmVersion,
      hasHappy: avatar.hasExpression('happy'),
      setMissing: avatar.setExpression('non-existing-expression', 1),
      setAa: avatar.setExpression('aa', 2),
      aa: avatar.getExpression('aa'),
      lookAt: avatar.supportsLookAt,
    };
  });
  expect(state).toEqual({
    loaded: true,
    version: '1',
    hasHappy: true,
    setMissing: false,
    setAa: true,
    aa: 1,
    lookAt: true,
  });

  // Idle time advances → the rAF loop is alive.
  const t0 = await page.evaluate(() => window.__AVATAR_DEBUG__!.idle.state.time);
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.idle.state.time)).toBeGreaterThan(t0 + 0.2);
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.fps)).toBeGreaterThan(0);

  expect(errors).toEqual([]);
});

test('canvas follows viewport resize without distortion', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'true');

  await page.setViewportSize({ width: 600, height: 900 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { stage } = window.__AVATAR_DEBUG__!;
        const c = stage.renderer.domElement;
        return {
          aspect: Number(stage.camera.aspect.toFixed(3)),
          css: [c.clientWidth, c.clientHeight],
          bufferAspect: Number((c.width / c.height).toFixed(2)),
        };
      }),
    )
    .toEqual({ aspect: Number((600 / 900).toFixed(3)), css: [600, 900], bufferAspect: 0.67 });
});

test('a failing model load is reported, not silent', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
  await page.route('**/models/avatar.vrm', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await page.goto('/');

  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'error');
  await expect(page.getByRole('alert')).toContainText('Avatar failed to load');
  expect(consoleErrors.some((e) => e.includes('failed to initialise'))).toBe(true);
  await expect(page.getByTestId('debug-overlay')).toContainText('VRM loaded  no');
});
