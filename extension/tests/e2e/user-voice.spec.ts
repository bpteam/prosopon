import type { Page, Worker } from '@playwright/test';
import { writeFakeMicWav } from './fakeMic';
import { expect, hasOffscreen, micInfo, overlayCounts, root, setMic, tabIdOf, tabState, test, toggle } from './extension';

/**
 * US-005 end to end with Chromium's fake microphone: WAV → getUserMedia in the offscreen document → worklet
 * analyser → UserVoiceFrame over the Port → content → ConversationSignalResolver → AvatarController state.
 *
 * The fake mic plays its file from the moment the capture opens (setMic), so the timeline below is relative to
 * that: 1 s room noise, 2.5 s of speech, 6.5 s of silence, 3 s of speech (the interruption), silence.
 */
const TIMELINE = writeFakeMicWav([
  { kind: 'silence', seconds: 1 },
  { kind: 'speech', seconds: 2.5, hz: 140 },
  { kind: 'silence', seconds: 6.5 },
  { kind: 'speech', seconds: 3, hz: 170 },
  { kind: 'silence', seconds: 6 },
]);

async function enableWithVoiceUi(sw: Worker, page: Page) {
  const tabId = await tabIdOf(sw, page);
  await toggle(sw, tabId);
  const host = root(page);
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await page.evaluate(() => (window as any).fixture.openVoice());
  await expect(host).toHaveAttribute('data-avatar-state', 'listening');
  return { tabId, host };
}

test.describe('fake microphone', () => {
  test.use({ fakeMicWav: TIMELINE });

  test('conversation: user speaks → listening, stops → thinking, assistant → speaking, interruption → listening', async ({
    serviceWorker,
    chatgpt,
  }) => {
    const { host } = await enableWithVoiceUi(serviceWorker, chatgpt);
    // Opt-in: nothing listens before this.
    expect(await micInfo(serviceWorker)).toMatchObject({ state: 'off', liveTracks: 0, pipelines: 0 });
    await expect(host).toHaveAttribute('data-mic', 'off');

    expect(await setMic(serviceWorker, true)).toEqual({ state: 'on' });
    await expect(host).toHaveAttribute('data-mic', 'on');

    // User speaks: the offscreen VAD reports it, the resolver keeps the avatar listening.
    await expect(host).toHaveAttribute('data-user-speaking', 'true', { timeout: 5_000 });
    await expect(host).toHaveAttribute('data-resolved-state', 'listening');
    await expect(host).toHaveAttribute('data-avatar-state', 'listening');
    await expect.poll(async () => Number(await host.getAttribute('data-user-energy'))).toBeGreaterThan(0.2);
    await expect.poll(async () => Number(await host.getAttribute('data-user-pitch'))).toBeGreaterThan(100);
    // The user's voice never reaches the avatar's mouth.
    expect(Number(await host.getAttribute('data-mouth-peak'))).toBe(0);

    // User stops: thinking, and a meaningful utterance ends with a nod.
    await expect(host).toHaveAttribute('data-user-speaking', 'false', { timeout: 6_000 });
    await expect(host).toHaveAttribute('data-avatar-state', 'thinking');
    await expect(host).toHaveAttribute('data-nods', '1');

    // Assistant starts (captured tab audio): speaking, and lip sync still moves the mouth.
    await chatgpt.evaluate(() => (window as any).fixture.playSpeech());
    await expect(host).toHaveAttribute('data-avatar-state', 'speaking');
    await expect(host).toHaveAttribute('data-assistant-speaking', 'true');
    await expect.poll(async () => Number(await host.getAttribute('data-mouth-peak'))).toBeGreaterThan(0.2);

    // Interruption: the second utterance arrives while the assistant is still talking. User wins.
    await expect(host).toHaveAttribute('data-user-speaking', 'true', { timeout: 10_000 });
    await expect(host).toHaveAttribute('data-avatar-state', 'listening');
    await expect(host).toHaveAttribute('data-assistant-speaking', 'true');
    expect(Number(await host.getAttribute('data-crosstalk'))).toBeGreaterThanOrEqual(1);

    // User done, assistant (the fixture doesn't stop like ChatGPT would) still going: back to speaking.
    await expect(host).toHaveAttribute('data-user-speaking', 'false', { timeout: 6_000 });
    await expect(host).toHaveAttribute('data-avatar-state', 'speaking');

    await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());
    await expect(host).toHaveAttribute('data-avatar-state', 'listening');
  });

  test('the mic only feeds the analyser: no path to the speakers', async ({ serviceWorker, chatgpt }) => {
    await enableWithVoiceUi(serviceWorker, chatgpt);
    await setMic(serviceWorker, true);
    expect(await micInfo(serviceWorker)).toEqual({
      state: 'on',
      liveTracks: 1,
      pipelines: 1,
      analyserOutputs: 0,
      reachedDestination: false,
    });
  });

  test('turning reactions off releases the mic; SPA navigation never duplicates it; disabling Prosopon stops it', async ({
    serviceWorker,
    chatgpt,
  }) => {
    const { tabId, host } = await enableWithVoiceUi(serviceWorker, chatgpt);
    await setMic(serviceWorker, true);
    await expect(host).toHaveAttribute('data-user-speaking', 'true', { timeout: 5_000 });

    // Off: track stopped, pipeline gone, user state reset on the page.
    expect(await setMic(serviceWorker, false)).toEqual({ state: 'off' });
    expect(await micInfo(serviceWorker)).toMatchObject({ liveTracks: 0, pipelines: 0 });
    await expect(host).toHaveAttribute('data-mic', 'off');
    await expect(host).toHaveAttribute('data-user-speaking', 'false');

    // On again, then SPA navigations and repeated state messages: still one pipeline, one track, one overlay.
    await setMic(serviceWorker, true);
    await setMic(serviceWorker, true);
    for (let i = 0; i < 4; i++) {
      await chatgpt.evaluate((n) => {
        const f = (window as any).fixture;
        f.navigate(`/c/conversation-${n}`);
        f.closeVoice();
        f.openVoice();
      }, i);
      await serviceWorker.evaluate((id) => chrome.tabs.sendMessage(id, { v: 1, type: 'tab:state', state: 'enabled' }), tabId);
    }
    expect(await micInfo(serviceWorker)).toMatchObject({ state: 'on', liveTracks: 1, pipelines: 1 });
    expect(await overlayCounts(chatgpt)).toEqual({ roots: 1, canvases: 1 });
    // User frames arrive at ~25 Hz, not doubled by a second pipeline or port.
    const f0 = Number(await host.getAttribute('data-user-frames'));
    await chatgpt.waitForTimeout(2000);
    const rate = (Number(await host.getAttribute('data-user-frames')) - f0) / 2;
    expect(rate).toBeGreaterThan(15);
    expect(rate).toBeLessThan(35);

    // Disabling Prosopon closes the offscreen document, and the mic with it.
    await toggle(serviceWorker, tabId);
    expect((await tabState(serviceWorker, tabId)).state).toBe('disabled');
    await expect.poll(() => hasOffscreen(serviceWorker)).toBe(false);
    expect(await micInfo(serviceWorker)).toBeNull();

    // Re-enabling with the opt-in still on brings the mic back by itself.
    await toggle(serviceWorker, tabId);
    await expect(host).toHaveAttribute('data-mic', 'on', { timeout: 30_000 });
    expect(await micInfo(serviceWorker)).toMatchObject({ liveTracks: 1, pipelines: 1 });
  });
});

test.describe('microphone permission denied', () => {
  test.use({ fakeMicWav: TIMELINE, grantMic: false });

  test('avatar and lip sync keep working; the user asking for reactions opens the permission page', async ({
    context,
    serviceWorker,
    chatgpt,
    extensionId,
  }) => {
    const { host } = await enableWithVoiceUi(serviceWorker, chatgpt);
    const pageOpened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/permission/index.html') });
    expect(await setMic(serviceWorker, true, true)).toMatchObject({ state: 'denied' });
    const permissionPage = await pageOpened;
    expect(permissionPage.url()).toBe(`chrome-extension://${extensionId}/permission/index.html`);
    // The page is what asks: the prompt stays open in headless Chromium, nobody answers it here.
    await expect(permissionPage.locator('main')).toContainText('never recorded, stored or sent');
    await expect(permissionPage.locator('#status')).toContainText('Waiting for your answer');

    await expect(host).toHaveAttribute('data-mic', 'denied');
    await expect(host).toHaveAttribute('data-user-speaking', 'false');
    expect(await micInfo(serviceWorker)).toMatchObject({ state: 'denied', liveTracks: 0, pipelines: 0 });

    await chatgpt.bringToFront();
    await chatgpt.evaluate(() => (window as any).fixture.playSpeech());
    await expect(host).toHaveAttribute('data-avatar-state', 'speaking');
    await expect.poll(async () => Number(await host.getAttribute('data-mouth-peak'))).toBeGreaterThan(0.2);
  });
});
