import { expect, test, type Page } from '@playwright/test';

/**
 * US-008 in the sandbox with the real VRM: gestures reach the bones through BehaviorMixer → Avatar, the scheduler is
 * seeded (?gestureSeed) so runs are reproducible, and nothing drifts over a long synthetic conversation.
 */

async function load(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(`/${query}`);
  await expect(page.locator('body')).toHaveAttribute('data-avatar-loaded', 'true');
  return errors;
}

test('assistant speaking with emotion → a gesture eventually appears (seeded)', async ({ page }) => {
  // Headless rAF runs at a few Hz with capped deltas: avatar time is slower than wall time.
  test.setTimeout(120_000);
  const errors = await load(page, '?analyzer=none&gestureSeed=7');
  await expect(page.getByTestId('gesture-panel')).toBeVisible();
  // Scale the rates up so the test does not wait minutes of avatar time; the scheduler logic is unchanged.
  await page.evaluate(() => (window.__AVATAR_DEBUG__!.gesture.engine.config.rateScale = 30));

  await page.evaluate(() => window.__AVATAR_DEBUG__!.audio.startTestSignal());
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.state), { timeout: 15_000 }).toBe('speaking');
  await expect
    .poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.emotion.value.assistant.confidence), { timeout: 15_000 })
    .toBeGreaterThan(0.2);
  await expect
    .poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.gesture.engine.history.gestureCount), { timeout: 60_000 })
    .toBeGreaterThan(0);
  // Lip sync keeps the mouth while gestures run.
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.avatar!.getProcedural().aa)).toBeGreaterThan(0.05);
  await page.evaluate(() => window.__AVATAR_DEBUG__!.audio.stop());
  expect(errors).toEqual([]);
});

test('manual triggers from the Gestures folder move the real bones and show in the overlay; cancel releases', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await load(page, '?analyzer=none&gestureSeed=1');
  await page.evaluate(() => (window.__AVATAR_DEBUG__!.gesture.auto = false));
  const panel = page.getByTestId('gesture-panel');
  for (const label of ['Nod', 'Double Nod', 'Head Tilt', 'Body Shift', 'Shoulder Shift', 'Hand Emphasis', 'Cancel']) {
    await expect(panel.getByRole('button', { name: label, exact: true })).toHaveCount(1);
  }

  await panel.getByRole('button', { name: 'Hand Emphasis', exact: true }).click();
  await expect(page.getByTestId('debug-overlay')).toContainText('gesture     hand-emphasis');
  // The arm leaves its rest rotation (REST_POSE, not T-pose) and comes back to exactly it.
  const armQuat = () =>
    page.evaluate(() => {
      const a = window.__AVATAR_DEBUG__!.avatar!;
      return ['leftUpperArm', 'rightUpperArm'].map((b) => a.getBone(b as 'leftUpperArm')!.quaternion.toArray() as number[]);
    });
  await page.evaluate(() => window.__AVATAR_DEBUG__!.gesture.cancel());
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.gesture.current.active), { timeout: 30_000 }).toBe(false);
  const rest = await armQuat();
  await page.evaluate(() => window.__AVATAR_DEBUG__!.gesture.trigger('hand-emphasis', 1));
  await expect
    .poll(async () => {
      const now = await armQuat();
      return Math.max(...now.flatMap((q, i) => q.map((v, k) => Math.abs(v - rest[i]![k]!))));
    })
    .toBeGreaterThan(0.01);
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__AVATAR_DEBUG__!.gesture.current.active), { timeout: 30_000 }).toBe(false);
  // A frame later the bones are rewritten from rest + zero offsets.
  await expect
    .poll(async () => {
      const now = await armQuat();
      return Math.max(...now.flatMap((q, i) => q.map((v, k) => Math.abs(v - rest[i]![k]!))));
    })
    .toBeLessThan(1e-9);

  await panel.getByRole('button', { name: 'Nod', exact: true }).click();
  await expect(page.getByTestId('debug-overlay')).toContainText('gesture     nod');
  expect(errors).toEqual([]);
});

test('long synthetic conversation: no pose drift, no stuck gesture, blink and mouth untouched', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await load(page, '?analyzer=none&gestureSeed=3');
  const result = await page.evaluate(() => {
    const d = window.__AVATAR_DEBUG__!;
    const c = d.controller;
    const g = d.gesture.engine;
    const a = d.avatar!;
    const bones = ['head', 'neck', 'chest', 'spine', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'] as const;
    const snapshot = () => bones.map((b) => a.getBone(b)?.quaternion.toArray() ?? []);
    // Deterministic baseline: no idle motion, idle state, nothing else driving the pose.
    d.idle.config.enabled = false;
    d.idle.config.blinkEnabled = false;
    c.setState('idle');
    for (let i = 0; i < 600; i++) c.update(1 / 60);
    const rest = snapshot();

    g.config.rateScale = 5;
    const states = ['listening', 'thinking', 'speaking', 'idle'] as const;
    const frame = { active: true, valence: 0.3, arousal: 0.85, energy: 0.7, tension: 0.2, pitchLift: 0.3, pitchVariation: 0.6, confidence: 0.9, valenceConfidence: 0.25, speechRate: 0.5, mode: 'heuristic' as const };
    let t = 0;
    let maxAbsArm = 0;
    let mouthTouched = false;
    let blinkTouched = false;
    for (let turn = 0; t < 5 * 60; turn++) {
      const state = states[turn % states.length]!;
      c.setState(state);
      for (let i = 0; i < (3 + (turn % 4)) * 60; i++) {
        if (i % 8 === 0) {
          d.emotion.push('assistant', { ...frame, active: state === 'speaking' });
          d.emotion.push('user', { ...frame, arousal: 0.5, active: state === 'listening' });
        }
        c.update(1 / 60);
        t += 1 / 60;
        const p = a.getProcedural();
        maxAbsArm = Math.max(maxAbsArm, Math.abs(p.leftUpperArmX), Math.abs(p.rightUpperArmX));
        if (p.aa + p.ih + p.ou + p.ee + p.oh > 0) mouthTouched = true;
        if (p.blink > 0) blinkTouched = true;
      }
    }
    const count = g.history.gestureCount;
    const nods = g.nods;
    g.enabled = false;
    c.setState('idle');
    // Let emotion decay (stale) and the state blend settle.
    for (let i = 0; i < 60 * 10; i++) c.update(1 / 60);
    const after = snapshot();
    let drift = 0;
    for (let i = 0; i < rest.length; i++) for (let k = 0; k < rest[i]!.length; k++) drift = Math.max(drift, Math.abs(after[i]![k]! - rest[i]![k]!));
    return { count, nods, drift, maxAbsArm, stuck: g.current.active, mouthTouched, blinkTouched };
  });
  expect(result.count).toBeGreaterThan(20);
  expect(result.nods).toBeGreaterThan(0);
  expect(result.maxAbsArm).toBeGreaterThan(0);
  expect(result.stuck).toBe(false);
  expect(result.drift).toBeLessThan(1e-9);
  expect(result.mouthTouched).toBe(false);
  expect(result.blinkTouched).toBe(false);
  expect(errors).toEqual([]);
});
