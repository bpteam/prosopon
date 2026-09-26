import type { Locator, Page, Worker } from '@playwright/test';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFakeMicWav } from './fakeMic';
import { EXTENSION_DIR, expect, root, setMic, tabIdOf, test, toggle } from './extension';

/**
 * US-006 end to end: tab audio → offscreen feature worklet → ProsodyEmotionAnalyzer (assistant) and fake mic →
 * UserVoicePipeline → ProsodyEmotionAnalyzer (user) → EmotionFrame over the Port → EmotionChannels → BehaviorMixer.
 * Observed through the development build's data-* attributes on the overlay host.
 *
 * Synthetic voices only (see fixtures/chatgpt.html playVoice): this checks the plumbing and the direction of the
 * rules, not calibration, which needs a real microphone and real ChatGPT audio.
 */

const num = async (host: Locator, attr: string) => Number(await host.getAttribute(attr));

async function enableWithVoiceUi(sw: Worker, page: Page) {
  const tabId = await tabIdOf(sw, page);
  await toggle(sw, tabId);
  const host = root(page);
  await expect(host).toHaveAttribute('data-avatar-loaded', 'true', { timeout: 30_000 });
  await page.evaluate(() => (window as any).fixture.openVoice());
  await expect(host).toHaveAttribute('data-avatar-state', 'listening');
  return host;
}

/** Samples an attribute every `every` ms for `ms` ms. */
async function sample(host: Locator, attr: string, ms: number, every = 100): Promise<number[]> {
  const out: number[] = [];
  for (let t = 0; t < ms; t += every) {
    out.push(await num(host, attr));
    await new Promise((r) => setTimeout(r, every));
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('assistant voice: calm vs energetic change the avatar; lip sync keeps working; silence fades to neutral', async ({
  serviceWorker,
  chatgpt,
}) => {
  test.setTimeout(90_000);
  const host = await enableWithVoiceUi(serviceWorker, chatgpt);
  await expect(host).toHaveAttribute('data-emotion-model', 'off');

  await chatgpt.evaluate(() => (window as any).fixture.playVoice('calm'));
  await expect(host).toHaveAttribute('data-avatar-state', 'speaking');
  await expect(host).toHaveAttribute('data-assistant-emotion-active', 'true', { timeout: 5_000 });
  await expect(host).toHaveAttribute('data-assistant-emotion-mode', 'heuristic');
  await new Promise((r) => setTimeout(r, 2500));
  const calm = await sample(host, 'data-assistant-emotion-arousal', 2000);
  const calmMix = await num(host, 'data-emotion-mix-assistant');
  await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());
  await expect(host).toHaveAttribute('data-assistant-emotion-active', 'false', { timeout: 5_000 });

  await chatgpt.evaluate(() => (window as any).fixture.playVoice('energetic'));
  await expect(host).toHaveAttribute('data-avatar-state', 'speaking');
  await new Promise((r) => setTimeout(r, 3000));
  const energetic = await sample(host, 'data-assistant-emotion-arousal', 2000);
  // Lip sync is untouched by the emotion channel: the mouth still follows the audio.
  await expect.poll(() => num(host, 'data-mouth-peak')).toBeGreaterThan(0.2);
  expect(mean(energetic) - mean(calm)).toBeGreaterThan(0.1);
  expect(calmMix).toBeGreaterThan(0);
  await expect.poll(() => num(host, 'data-emotion-mix-assistant')).toBeGreaterThan(0.2);
  // The user channel stays silent: nothing crosses from the assistant's analyser.
  expect(await host.getAttribute('data-user-emotion-frames')).toBe('0');

  // Silence: influence decays smoothly (no snap to zero), then reaches neutral.
  const before = await num(host, 'data-assistant-emotion-arousal');
  await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());
  const tail = await sample(host, 'data-assistant-emotion-arousal', 4000, 200);
  expect(tail[2]!).toBeGreaterThan(before * 0.3);
  for (let i = 1; i < tail.length; i++) expect(tail[i]!).toBeLessThanOrEqual(tail[i - 1]! + 0.02);
  await expect.poll(() => num(host, 'data-assistant-emotion-arousal'), { timeout: 10_000 }).toBeLessThan(0.02);
  await expect.poll(() => num(host, 'data-emotion-mix-assistant'), { timeout: 10_000 }).toBeLessThan(0.02);
});

test('Dev Tools switch turns assistant emotion expression off independently', async ({ serviceWorker, chatgpt }) => {
  const host = await enableWithVoiceUi(serviceWorker, chatgpt);
  await chatgpt.evaluate(() => (window as any).fixture.playVoice('energetic'));
  await expect.poll(() => num(host, 'data-emotion-mix-assistant'), { timeout: 10_000 }).toBeGreaterThan(0.2);
  // The switch lives in Developer Tools → Emotion (Developer mode), not on the render overlay.
  await serviceWorker.evaluate(() => chrome.storage.local.set({ 'prosopon.developerMode': true }));
  const ui = chatgpt.locator('#prosopon-ui');
  await expect(ui).toHaveAttribute('data-dev-tools', 'mounted');
  await ui.locator('[data-testid="dev-window-hud"] [data-action="expand"]').click();
  await ui.locator('[data-testid="dev-window-devtools"] [role="tab"][data-tab="Emotion"]').click();
  const box = ui.locator('#prosopon-assistant-emotion');
  await expect(box).toBeChecked();
  await box.click();
  await expect(host).toHaveAttribute('data-assistant-emotion-enabled', 'false');
  await expect.poll(() => num(host, 'data-emotion-mix-assistant')).toBeLessThan(0.01);
  await expect(host).toHaveAttribute('data-user-emotion-enabled', 'true');
  // Analysis keeps running; only its influence is off.
  await expect(host).toHaveAttribute('data-assistant-emotion-active', 'true');
  await chatgpt.evaluate(() =>
    document.dispatchEvent(new CustomEvent('prosopon:emotion', { detail: { channel: 'assistant', enabled: true } })),
  );
  await expect(box).toBeChecked();
  await expect.poll(() => num(host, 'data-emotion-mix-assistant')).toBeGreaterThan(0.2);
});

// 1 s room noise, 3 s speech, 4 s silence, 4 s speech (the interruption), silence.
const USER_TIMELINE = writeFakeMicWav([
  { kind: 'silence', seconds: 1 },
  { kind: 'speech', seconds: 3, hz: 150 },
  { kind: 'silence', seconds: 4 },
  { kind: 'speech', seconds: 4, hz: 170 },
  { kind: 'silence', seconds: 8 },
]);

test.describe('user voice', () => {
  test.use({ fakeMicWav: USER_TIMELINE });

  test('user speech → userEmotion → reaction layer; interruption swaps priorities; mouth untouched', async ({
    serviceWorker,
    chatgpt,
  }) => {
    test.setTimeout(90_000);
    const host = await enableWithVoiceUi(serviceWorker, chatgpt);
    expect(await setMic(serviceWorker, true)).toEqual({ state: 'on' });

    // First utterance: the user channel becomes active and drives the reaction layer while listening.
    await expect(host).toHaveAttribute('data-user-emotion-active', 'true', { timeout: 6_000 });
    await expect(host).toHaveAttribute('data-avatar-state', 'listening');
    await expect.poll(() => num(host, 'data-emotion-mix-user')).toBeGreaterThan(0.1);
    expect(await num(host, 'data-emotion-mix-assistant')).toBe(0);
    expect(await num(host, 'data-mouth-peak')).toBe(0);
    await expect(host).toHaveAttribute('data-user-speaking', 'false', { timeout: 6_000 });

    // Assistant answers: assistant emotion takes over self-expression, the user's weight drops to 0.
    await chatgpt.evaluate(() => (window as any).fixture.playVoice('energetic'));
    await expect(host).toHaveAttribute('data-avatar-state', 'speaking');
    await expect.poll(() => num(host, 'data-emotion-mix-assistant'), { timeout: 8_000 }).toBeGreaterThan(0.2);
    await expect.poll(() => num(host, 'data-emotion-mix-user')).toBe(0);
    const assistantWhileSpeaking = await num(host, 'data-emotion-mix-assistant');

    // Interruption: the second utterance arrives while the assistant still talks.
    await expect(host).toHaveAttribute('data-avatar-state', 'listening', { timeout: 10_000 });
    await expect(host).toHaveAttribute('data-assistant-speaking', 'true');
    await expect.poll(() => num(host, 'data-emotion-mix-assistant')).toBeLessThan(assistantWhileSpeaking * 0.4);
    await expect.poll(() => num(host, 'data-emotion-mix-user')).toBeGreaterThan(0.1);
    // Mouth still follows the assistant only.
    await expect.poll(() => num(host, 'data-mouth-peak')).toBeGreaterThan(0.2);

    // User emotion reactions off: the user's weight goes to 0 while the channel keeps analysing.
    await chatgpt.evaluate(() =>
      document.dispatchEvent(new CustomEvent('prosopon:emotion', { detail: { channel: 'user', enabled: false } })),
    );
    await expect.poll(() => num(host, 'data-emotion-mix-user')).toBeLessThan(0.01);
    await expect(host).toHaveAttribute('data-assistant-emotion-enabled', 'true');
    await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());

    // Mic off: the user channel is dropped at once.
    await setMic(serviceWorker, false);
    await expect(host).toHaveAttribute('data-user-emotion-active', 'false');
  });
});

// --- Local model (ONNX Runtime Web) --------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const PROBE = resolve(here, '../../../avatar/tests/fixtures/loudness-probe.onnx');

/** A copy of the built extension with a packaged emotion-model/model.json (the probe fixture, not a real model). */
function extensionWithModel(model: Record<string, unknown>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'prosopon-ext-')), 'ext');
  cpSync(EXTENSION_DIR, dir, { recursive: true });
  mkdirSync(join(dir, 'emotion-model'));
  copyFileSync(PROBE, join(dir, 'emotion-model', 'loudness-probe.onnx'));
  writeFileSync(join(dir, 'emotion-model', 'model.json'), JSON.stringify(model));
  return dir;
}

const PROBE_MODEL = {
  file: 'loudness-probe.onnx',
  sampleRate: 16000,
  windowSeconds: 1,
  arousalIndex: 0,
  valenceIndex: 2,
  outputRange: [0, 1],
  trust: 0.6,
  inferInterval: 0.5,
};

test.describe('local model on the WASM backend', () => {
  test.use({ extensionDir: extensionWithModel({ ...PROBE_MODEL, preferWebGpu: false }) });

  test('model loads, runs on assistant audio, frames report ml-wasm; lip sync unaffected', async ({ serviceWorker, chatgpt }) => {
    const host = await enableWithVoiceUi(serviceWorker, chatgpt);
    await expect(host).toHaveAttribute('data-emotion-model', 'ready', { timeout: 20_000 });
    await chatgpt.evaluate(() => (window as any).fixture.playVoice('energetic'));
    await expect(host).toHaveAttribute('data-assistant-emotion-mode', 'ml-wasm', { timeout: 8_000 });
    await expect(host).toHaveAttribute('data-assistant-emotion-active', 'true');
    // The model actually runs on the captured audio (the probe's output is loudness, so nothing to assert on it).
    await expect.poll(() => num(host, 'data-emotion-inferences'), { timeout: 10_000 }).toBeGreaterThan(2);
    await expect.poll(() => num(host, 'data-mouth-peak')).toBeGreaterThan(0.2);
    // Silence: no model runs are spent on it.
    await chatgpt.evaluate(() => (window as any).fixture.stopSpeech());
    await expect(host).toHaveAttribute('data-assistant-emotion-active', 'false', { timeout: 5_000 });
    const settled = await num(host, 'data-emotion-inferences');
    await new Promise((r) => setTimeout(r, 2000));
    expect(await num(host, 'data-emotion-inferences')).toBe(settled);
  });
});

test.describe('local model on the WebGPU backend (SwiftShader adapter)', () => {
  test.use({
    extensionDir: extensionWithModel(PROBE_MODEL),
    // Headless Chromium has no GPU adapter; a software Vulkan one lets the WebGPU path run for real.
    chromiumArgs: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader'],
  });

  test('WebGPU is used when an adapter exists, and inference runs on it', async ({ serviceWorker, chatgpt }) => {
    const host = await enableWithVoiceUi(serviceWorker, chatgpt);
    await expect(host).toHaveAttribute('data-emotion-model', 'ready', { timeout: 30_000 });
    await chatgpt.evaluate(() => (window as any).fixture.playVoice('energetic'));
    await expect(host).toHaveAttribute('data-assistant-emotion-mode', 'ml-webgpu', { timeout: 8_000 });
    await expect.poll(() => num(host, 'data-emotion-inferences'), { timeout: 15_000 }).toBeGreaterThan(2);
    await expect(host).toHaveAttribute('data-emotion-model', 'ready');
    await expect.poll(() => num(host, 'data-mouth-peak')).toBeGreaterThan(0.2);
  });
});

test.describe('local model that cannot load', () => {
  test.use({ extensionDir: extensionWithModel({ ...PROBE_MODEL, file: 'missing.onnx' }) });

  test('falls back to prosody rules: mode fallback, avatar and emotion keep working', async ({ serviceWorker, chatgpt }) => {
    const host = await enableWithVoiceUi(serviceWorker, chatgpt);
    await expect(host).toHaveAttribute('data-emotion-model', 'failed', { timeout: 20_000 });
    await chatgpt.evaluate(() => (window as any).fixture.playVoice('energetic'));
    await expect(host).toHaveAttribute('data-assistant-emotion-mode', 'fallback', { timeout: 8_000 });
    await expect(host).toHaveAttribute('data-assistant-emotion-active', 'true');
    await expect.poll(() => num(host, 'data-emotion-mix-assistant')).toBeGreaterThan(0.1);
    await expect.poll(() => num(host, 'data-mouth-peak')).toBeGreaterThan(0.2);
  });
});
