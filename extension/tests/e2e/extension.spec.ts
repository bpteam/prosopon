import { expect, hasOffscreen, overlayCounts, root, tabIdOf, tabState, test, toggle } from './extension';

test('extension loads: service worker starts and the content script injects on chatgpt.com only', async ({
  context,
  serviceWorker,
  extensionId,
  chatgpt,
}) => {
  expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
  await expect(chatgpt.locator('html')).toHaveAttribute('data-prosopon-content', 'ready');
  // Disabled by default: nothing on the page yet.
  expect(await overlayCounts(chatgpt)).toEqual({ roots: 0, canvases: 0 });

  const other = await context.newPage();
  await other.goto('about:blank');
  await expect(other.locator('html')).not.toHaveAttribute('data-prosopon-content', 'ready');
});

test('enable shows the avatar; voice UI appearing/disappearing moves it and hides/restores the orb', async ({
  serviceWorker,
  chatgpt,
}) => {
  const tabId = await tabIdOf(serviceWorker, chatgpt);
  await toggle(serviceWorker, tabId);
  expect((await tabState(serviceWorker, tabId)).state).toBe('enabled');

  const host = root(chatgpt);
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await expect(host).toHaveAttribute('data-offscreen', 'true');
  await expect(host).toHaveAttribute('data-placement', 'fallback');
  await expect(host).toHaveAttribute('data-voice-ui', 'false');
  expect(await overlayCounts(chatgpt)).toEqual({ roots: 1, canvases: 1 });

  // Overlay must not take clicks from ChatGPT.
  await expect(host).toHaveCSS('pointer-events', 'none');
  await expect(host).toHaveCSS('position', 'fixed');

  await chatgpt.evaluate(() => (window as any).fixture.openVoice());
  await expect(host).toHaveAttribute('data-voice-ui', 'true');
  await expect(host).toHaveAttribute('data-placement', 'anchor');
  await expect(host).toHaveAttribute('data-avatar-state', 'listening');
  const orb = chatgpt.locator('[data-realtime-voice-orb]');
  await expect(orb).toHaveCSS('visibility', 'hidden');
  await expect(orb).toBeAttached(); // hidden, never removed

  // Overlay sits over the orb and inside the viewport.
  const [orbBox, hostBox] = [await orb.boundingBox(), await host.boundingBox()];
  expect(orbBox && hostBox).toBeTruthy();
  const orbCenter = { x: orbBox!.x + orbBox!.width / 2, y: orbBox!.y + orbBox!.height / 2 };
  expect(orbCenter.x).toBeGreaterThan(hostBox!.x);
  expect(orbCenter.x).toBeLessThan(hostBox!.x + hostBox!.width);
  expect(orbCenter.y).toBeGreaterThan(hostBox!.y);
  expect(orbCenter.y).toBeLessThan(hostBox!.y + hostBox!.height);

  // The page can still be used through the overlay.
  await chatgpt.locator('#close-voice').click();
  await expect(host).toHaveAttribute('data-voice-ui', 'false');
  await expect(host).toHaveAttribute('data-placement', 'fallback');
  await expect(host).toHaveAttribute('data-avatar-state', 'idle');

  // Page CSS doesn't reach the canvas in the shadow root.
  const canvasStyle = await chatgpt.evaluate(() => {
    const c = document.getElementById('prosopon-root')!.shadowRoot!.querySelector('canvas')!;
    const s = getComputedStyle(c);
    return { border: s.borderTopWidth, opacity: s.opacity };
  });
  expect(canvasStyle).toEqual({ border: '0px', opacity: '1' });
});

test('mutations, SPA navigation and repeated state messages never duplicate the runtime', async ({
  serviceWorker,
  chatgpt,
}) => {
  const tabId = await tabIdOf(serviceWorker, chatgpt);
  await toggle(serviceWorker, tabId);
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });

  for (let i = 0; i < 5; i++) {
    await chatgpt.evaluate((n) => {
      const f = (window as any).fixture;
      f.churn(50);
      f.openVoice();
      f.navigate(`/c/conversation-${n}`);
      f.closeVoice();
      f.openVoice();
    }, i);
    // The SW re-announcing "enabled" (e.g. after a restart) must be a no-op.
    await serviceWorker.evaluate(
      (id) => chrome.tabs.sendMessage(id, { v: 1, type: 'tab:state', state: 'enabled' }),
      tabId,
    );
  }
  await expect(root(chatgpt)).toHaveAttribute('data-voice-ui', 'true');
  expect(await overlayCounts(chatgpt)).toEqual({ roots: 1, canvases: 1 });
  expect(await chatgpt.locator('[data-prosopon-hidden]').count()).toBe(1);

  // Frames arrive at the offscreen rate, not doubled by a second port.
  const f0 = Number(await root(chatgpt).getAttribute('data-frames'));
  await chatgpt.waitForTimeout(2000);
  const rate = (Number(await root(chatgpt).getAttribute('data-frames')) - f0) / 2;
  expect(rate).toBeGreaterThan(15);
  expect(rate).toBeLessThan(40);
});

test('real tab audio: captured → offscreen analyser → LipSyncFrame → content → mouth', async ({
  serviceWorker,
  chatgpt,
}) => {
  const tabId = await tabIdOf(serviceWorker, chatgpt);
  await toggle(serviceWorker, tabId);
  const host = root(chatgpt);
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await chatgpt.evaluate(() => (window as any).fixture.openVoice());
  await expect(host).toHaveAttribute('data-mouth-peak', '0.000');

  await chatgpt.evaluate(() => (window as any).fixture.playSpeech());
  await expect.poll(async () => Number(await host.getAttribute('data-mouth-peak'))).toBeGreaterThan(0.2);
  await expect(host).toHaveAttribute('data-audio-active', 'true');
  await expect(host).toHaveAttribute('data-avatar-state', 'speaking');
  await expect(host).toHaveAttribute('data-lip-sync-mode', /amplitude|viseme/);

  await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());
  await expect(host).toHaveAttribute('data-audio-active', 'false');
  await expect(host).toHaveAttribute('data-avatar-state', 'listening');
  await expect.poll(async () => Number(await host.getAttribute('data-mouth'))).toBeLessThan(0.02);
});

// Regression (US-005): the amplitude fallback has to carry the mouth when the viseme analyser is gone. Verified
// against real ChatGPT speech through the same 'prosopon:debug' hook this test uses.
test('viseme analyser failure falls back to amplitude without stopping lip sync', async ({
  serviceWorker,
  chatgpt,
}) => {
  const tabId = await tabIdOf(serviceWorker, chatgpt);
  await toggle(serviceWorker, tabId);
  const host = root(chatgpt);
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await chatgpt.evaluate(() => (window as any).fixture.playSpeech());
  await expect.poll(async () => Number(await host.getAttribute('data-mouth-peak'))).toBeGreaterThan(0.2);

  await chatgpt.evaluate(() =>
    document.dispatchEvent(new CustomEvent('prosopon:debug', { detail: { analyzer: 'none' } })),
  );
  await expect(host).toHaveAttribute('data-lip-sync-mode', 'amplitude');
  const frames = Number(await host.getAttribute('data-frames'));
  await expect.poll(async () => Number(await host.getAttribute('data-frames'))).toBeGreaterThan(frames + 10);
  await expect.poll(async () => Number(await host.getAttribute('data-mouth'))).toBeGreaterThan(0.05);

  await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());
  await expect.poll(async () => Number(await host.getAttribute('data-mouth'))).toBeLessThan(0.02);
});

test('page refresh keeps the tab enabled with a single overlay', async ({ serviceWorker, chatgpt }) => {
  const tabId = await tabIdOf(serviceWorker, chatgpt);
  await toggle(serviceWorker, tabId);
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });

  await chatgpt.reload();
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await expect(root(chatgpt)).toHaveAttribute('data-offscreen', 'true');
  expect(await overlayCounts(chatgpt)).toEqual({ roots: 1, canvases: 1 });
  expect((await tabState(serviceWorker, tabId)).state).toBe('enabled');

  await chatgpt.evaluate(() => (window as any).fixture.playSpeech());
  await expect.poll(async () => Number(await root(chatgpt).getAttribute('data-mouth-peak'))).toBeGreaterThan(0.2);
});

test('disable stops the capture, removes the overlay, restores the orb; repeated disable is safe', async ({
  serviceWorker,
  chatgpt,
}) => {
  const tabId = await tabIdOf(serviceWorker, chatgpt);
  await chatgpt.evaluate(() => (window as any).fixture.openVoice());
  await toggle(serviceWorker, tabId);
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await expect(chatgpt.locator('[data-realtime-voice-orb]')).toHaveCSS('visibility', 'hidden');
  expect(await hasOffscreen(serviceWorker)).toBe(true);

  await toggle(serviceWorker, tabId);
  expect((await tabState(serviceWorker, tabId)).state).toBe('disabled');
  await expect(root(chatgpt)).toHaveCount(0);
  await expect(chatgpt.locator('[data-realtime-voice-orb]')).toHaveCSS('visibility', 'visible');
  await expect(chatgpt.locator('[data-prosopon-hidden]')).toHaveCount(0);
  // Offscreen document closed = its capture, AudioContext and analysers are gone.
  await expect.poll(() => hasOffscreen(serviceWorker)).toBe(false);

  // Disabling again (message from the SW) is a no-op.
  await serviceWorker.evaluate(
    (id) => chrome.tabs.sendMessage(id, { v: 1, type: 'tab:state', state: 'disabled' }),
    tabId,
  );
  await expect(root(chatgpt)).toHaveCount(0);

  // And it can be enabled again.
  await toggle(serviceWorker, tabId);
  await expect(root(chatgpt)).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
});
