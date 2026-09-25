import { expect, test, type Page } from '@playwright/test';

/** 16-bit mono WAV: 130 Hz tone gated on/off every 200 ms (speech-like syllables), `seconds` long. */
function syllableWav(seconds: number, sampleRate = 16_000): Buffer {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const on = Math.floor(t / 0.2) % 2 === 0;
    const s = on ? 0.5 * Math.sin(2 * Math.PI * 130 * t) : 0;
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

async function loaded(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'true');
  return errors;
}

/** Samples the procedural mouth for `ms`, returns min/max of the driven "aa" weight. */
function sampleMouth(page: Page, ms: number) {
  return page.evaluate(
    (duration) =>
      new Promise<{ min: number; max: number; frames: number }>((resolve) => {
        const api = window.__AVATAR_DEBUG__!;
        let min = Infinity;
        let max = -Infinity;
        let frames = 0;
        const start = performance.now();
        const tick = () => {
          const v = api.avatar!.getProcedural().mouthOpen;
          min = Math.min(min, v);
          max = Math.max(max, v);
          frames++;
          if (performance.now() - start < duration) requestAnimationFrame(tick);
          else resolve({ min, max, frames });
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

/**
 * Records min/max of the procedural mouth on every frame from now on. Under software WebGL the loop runs at a
 * few FPS, so tests poll the accumulated extremes instead of sampling a fixed window.
 */
async function recordMouth(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __mouth: { min: number; max: number; afterMax: number } };
    const rec = (w.__mouth = { min: Infinity, max: -Infinity, afterMax: Infinity });
    const tick = () => {
      const v = window.__AVATAR_DEBUG__!.avatar!.getProcedural().mouthOpen;
      rec.min = Math.min(rec.min, v);
      rec.max = Math.max(rec.max, v);
      // Lowest value seen after the mouth has opened: proves it closes again between syllables.
      if (rec.max > 0.5) rec.afterMax = Math.min(rec.afterMax, v);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  return () => page.evaluate(() => (window as unknown as { __mouth: { min: number; max: number; afterMax: number } }).__mouth);
}

/** Max RMS read from the analyser on a 5 ms timer, independent of the render frame rate. */
function sampleRms(page: Page, ms: number) {
  return page.evaluate(
    (duration) =>
      new Promise<{ min: number; max: number }>((resolve) => {
        const audio = window.__AVATAR_DEBUG__!.audio;
        let min = Infinity;
        let max = 0;
        const start = performance.now();
        const timer = setInterval(() => {
          const v = audio.readRms();
          min = Math.min(min, v);
          max = Math.max(max, v);
          if (performance.now() - start > duration) {
            clearInterval(timer);
            resolve({ min, max });
          }
        }, 5);
      }),
    ms,
  );
}

test('mouth is closed without audio', async ({ page }) => {
  const errors = await loaded(page);
  const m = await sampleMouth(page, 500);
  expect(m.max).toBe(0);
  expect(errors).toEqual([]);
});

test('an audio file drives the mouth open and closed, then stops', async ({ page }) => {
  const errors = await loaded(page);
  const panel = page.getByTestId('lipsync-panel');
  await expect(panel).toBeVisible();

  const mouth = await recordMouth(page);
  const chooser = page.waitForEvent('filechooser');
  await panel.getByText('play audio file…').click();
  await (await chooser).setFiles({ name: 'syllables.wav', mimeType: 'audio/wav', buffer: syllableWav(6) });

  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.audio.kind)).toBe('file');
  await expect.poll(async () => (await mouth()).max).toBeGreaterThan(0.5);
  await expect.poll(async () => (await mouth()).afterMax).toBeLessThan(0.1);

  // Playback end releases the source and the mouth closes.
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.audio.kind), { timeout: 10_000 }).toBe('none');
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.avatar!.getProcedural().mouthOpen)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('the test signal drives the mouth until stopped', async ({ page }) => {
  const errors = await loaded(page);
  const panel = page.getByTestId('lipsync-panel');
  await panel.getByText('test signal').click();
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.audio.kind)).toBe('test');

  const mouth = await recordMouth(page);
  // The signal itself has syllables and pauses.
  const rms = await sampleRms(page, 1500);
  expect(rms.max).toBeGreaterThan(0.05);
  expect(rms.min).toBeLessThan(0.001);
  await expect.poll(async () => (await mouth()).max).toBeGreaterThan(0.3);

  await panel.getByText('stop', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.audio.kind)).toBe('none');
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.avatar!.getProcedural().mouthOpen)).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('the microphone drives the mouth (fake capture device)', async ({ page }) => {
  const errors = await loaded(page);
  await page.getByTestId('lipsync-panel').getByText('microphone').click();
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.audio.kind)).toBe('mic');
  // Chromium's fake device emits a short beep once a second: too short to hit reliably at a few FPS, so this
  // checks that the mic reaches the analyser; file and test-signal tests cover analyser → mouth.
  expect((await sampleRms(page, 2500)).max).toBeGreaterThan(0.01);
  expect(errors).toEqual([]);
});
