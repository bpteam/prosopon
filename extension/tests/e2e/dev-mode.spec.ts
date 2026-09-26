import type { Page, Worker } from '@playwright/test';
import { expect, overlayCounts, root, tabIdOf, test, toggle } from './extension';

const ui = (page: Page) => page.locator('#prosopon-ui');

async function enable(sw: Worker, page: Page) {
  await toggle(sw, await tabIdOf(sw, page));
  await expect(root(page)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
}

function stored(sw: Worker, key: string): Promise<unknown> {
  return sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
}

async function openPopup(page: Page, extensionId: string) {
  await page.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await expect(page.locator('#dev-toggle')).toBeAttached();
}

test('popup: Developer mode and layout write chrome.storage.local; the page follows', async ({
  context,
  serviceWorker,
  extensionId,
  chatgpt,
}) => {
  await enable(serviceWorker, chatgpt);
  const popup = await context.newPage();
  await openPopup(popup, extensionId);

  // Default OFF: no diagnostics on the page.
  await expect(popup.locator('#dev-toggle')).not.toBeChecked();
  await expect(root(chatgpt)).toHaveAttribute('data-dev-mode', 'false');
  expect(await chatgpt.locator('#prosopon-ui').count()).toBe(0);

  await popup.locator('#dev-toggle').check();
  expect(await stored(serviceWorker, 'prosopon.developerMode')).toBe(true);
  await expect(ui(chatgpt)).toHaveAttribute('data-dev-tools', 'mounted');

  await popup.locator('#open-settings').click();
  await popup.locator('#settings-view [data-preset="face"]').click();
  await expect(root(chatgpt)).toHaveAttribute('data-camera-preset', 'face');
  await expect.poll(() => stored(serviceWorker, 'prosopon.view')).toMatchObject({ version: 1, camera: { preset: 'face' } });

  await popup.locator('#reset-layout').click();
  await expect(root(chatgpt)).toHaveAttribute('data-camera-preset', 'waist');
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-scale', '1.50');

  await popup.locator('#settings-back').click();
  await popup.locator('#dev-toggle').uncheck();
  await expect(root(chatgpt)).toHaveAttribute('data-dev-mode', 'false');
  await expect(chatgpt.locator('#prosopon-ui')).toHaveCount(0);
});

test('Developer mode flow: HUD, windows, presets, size, placement, persistence, off', async ({ serviceWorker, chatgpt }) => {
  test.setTimeout(120_000);
  const host = root(chatgpt);

  // 1. Avatar on, Developer mode off: only the render overlay, no in-page UI.
  await enable(serviceWorker, chatgpt);
  await expect(host).toHaveAttribute('data-camera-preset', 'waist');
  await expect(host).toHaveAttribute('data-avatar-scale', '1.50');
  await expect(host).toHaveAttribute('data-placement-x', '0.500');
  await expect(host).toHaveAttribute('data-placement-y', '0.540');
  await expect(chatgpt.locator('#prosopon-ui')).toHaveCount(0);

  // 2–3. On, then on again: one HUD, one toolbar.
  await serviceWorker.evaluate(() => chrome.storage.local.set({ 'prosopon.developerMode': true }));
  await expect(ui(chatgpt)).toHaveAttribute('data-dev-tools', 'mounted');
  await serviceWorker.evaluate(() => chrome.storage.local.set({ 'prosopon.developerMode': true }));
  const hud = ui(chatgpt).locator('[data-testid="dev-window-hud"]');
  await expect(hud).toHaveCount(1);
  await expect(ui(chatgpt).locator('[data-testid="quick-toolbar"]')).toHaveCount(1);
  await expect(chatgpt.locator('#prosopon-ui')).toHaveCount(1);
  // The HUD samples real state (idle before the voice UI opens).
  await expect(hud.locator('[data-testid="dev-state"]')).toContainText(/idle/i);

  // 4. The UI host takes clicks only on its windows; the render overlay stays click-through.
  await expect(host).toHaveCSS('pointer-events', 'none');

  // 5. HUD expand → Developer Tools; Avatar tab → Avatar Controls.
  await hud.locator('[data-action="expand"]').click();
  const devtools = ui(chatgpt).locator('[data-testid="dev-window-devtools"]');
  await expect(devtools).toBeVisible();
  await devtools.locator('[role="tab"][data-tab="Avatar"]').click();
  await devtools.locator('[data-testid="open-avatar-controls"]').click();
  const controls = ui(chatgpt).locator('[data-testid="dev-window-avatarControls"]');
  await expect(controls).toBeVisible();

  // 6. Presets from Avatar Controls and the toolbar.
  await controls.locator('[data-testid="camera-face"]').click();
  await expect(host).toHaveAttribute('data-camera-preset', 'face');
  await expect(ui(chatgpt).locator('[data-testid="toolbar-face"]')).toHaveAttribute('aria-pressed', 'true');
  await ui(chatgpt).locator('[data-testid="toolbar-full-body"]').click();
  await expect(host).toHaveAttribute('data-camera-preset', 'full-body');
  await expect(controls.locator('[data-testid="camera-status"]')).toHaveText('Full body');

  // 7. Size from the toolbar.
  await ui(chatgpt).locator('[data-testid="toolbar-larger"]').click();
  await expect(host).toHaveAttribute('data-avatar-scale', '1.55');
  await expect(ui(chatgpt).locator('[data-testid="toolbar-scale"]')).toHaveText('155%');

  // 8. Placement mode by keyboard: the box moves right, Escape finishes and removes the handle.
  await ui(chatgpt).locator('[data-testid="toolbar-move"]').click();
  const handle = ui(chatgpt).locator('[data-testid="placement-handle"]');
  await expect(handle).toBeFocused();
  for (let i = 0; i < 5; i++) await chatgpt.keyboard.press('Shift+ArrowRight');
  await chatgpt.keyboard.press('Escape');
  await expect(handle).toHaveCount(0);
  const x = Number(await host.getAttribute('data-placement-x'));
  expect(x).toBeGreaterThan(0.55);

  // 9. Escape closes the focused window (Avatar Controls), not the others.
  await controls.locator('[data-testid="camera-reset"]').focus();
  await chatgpt.keyboard.press('Escape');
  await expect(controls).toHaveCount(0);
  await expect(devtools).toBeVisible();

  // 10. Dragging Developer Tools moves it; bounds persist.
  const before = (await devtools.boundingBox())!;
  const head = devtools.locator('.win-head');
  const hb = (await head.boundingBox())!;
  await chatgpt.mouse.move(hb.x + 40, hb.y + hb.height / 2);
  await chatgpt.mouse.down();
  await chatgpt.mouse.move(hb.x - 60, hb.y + hb.height / 2 + 30, { steps: 5 });
  await chatgpt.mouse.up();
  const after = (await devtools.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(-100);
  await expect
    .poll(async () => ((await stored(serviceWorker, 'prosopon.devWindows')) as any)?.windows?.devtools?.x)
    .toBe(Math.round(after.x));

  // 11. Layout is persisted (flushed on change / pointerup).
  await expect
    .poll(() => stored(serviceWorker, 'prosopon.view'))
    .toMatchObject({ version: 1, camera: { preset: 'full-body' }, placement: { scale: 1.55 } });

  // 12. Reload: layout, Developer mode and open windows come back, once.
  await chatgpt.reload();
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await expect(host).toHaveAttribute('data-camera-preset', 'full-body');
  await expect(host).toHaveAttribute('data-avatar-scale', '1.55');
  await expect(host).toHaveAttribute('data-placement-x', x.toFixed(3));
  await expect(ui(chatgpt)).toHaveAttribute('data-dev-tools', 'mounted');
  await expect(ui(chatgpt).locator('[data-testid="dev-window-devtools"]')).toHaveCount(1);
  await expect(ui(chatgpt).locator('[data-testid="dev-window-avatarControls"]')).toHaveCount(0);
  const restored = (await ui(chatgpt).locator('[data-testid="dev-window-devtools"]').boundingBox())!;
  expect(Math.round(restored.x)).toBe(Math.round(after.x));

  // 13. Toolbar Reset: camera back to the preset's defaults (preset kept), marked unmodified.
  await ui(chatgpt).locator('[data-testid="toolbar-reset"]').click();
  await expect(host).toHaveAttribute('data-camera-modified', 'false');

  // 14. Closing the HUD does not strand the next Developer Mode session without its entry point.
  await hud.locator('[data-action="close"]').focus();
  await chatgpt.keyboard.press('Escape');
  await expect(hud).toHaveCount(0);

  // 15. Developer mode off from Dev Tools → Settings: every panel, the toolbar and the UI host are gone.
  await ui(chatgpt).locator('[data-testid="dev-window-devtools"] [role="tab"][data-tab="Settings"]').click();
  await ui(chatgpt).locator('[data-testid="dev-mode-off"]').click();
  await expect(chatgpt.locator('#prosopon-ui')).toHaveCount(0);
  await expect(host).toHaveAttribute('data-dev-mode', 'false');
  expect(await stored(serviceWorker, 'prosopon.developerMode')).toBe(false);

  // 16. A fresh session restores the default HUD even though it was closed in the prior one.
  await serviceWorker.evaluate(() => chrome.storage.local.set({ 'prosopon.developerMode': true }));
  await expect(ui(chatgpt).locator('[data-testid="dev-window-hud"]')).toHaveCount(1);

  // 17. The avatar keeps running with the saved layout.
  expect(await overlayCounts(chatgpt)).toEqual({ roots: 1, canvases: 1 });
  await expect(host).toHaveAttribute('data-camera-preset', 'full-body');
  await chatgpt.evaluate(() => (window as any).fixture.playSpeech());
  await expect.poll(async () => Number(await host.getAttribute('data-mouth-peak'))).toBeGreaterThan(0.2);
  // Frames keep arriving (transport rate shown in the HUD / Overview).
  await expect.poll(async () => Number(await host.getAttribute('data-frame-hz')), { timeout: 5_000 }).toBeGreaterThan(5);
});
