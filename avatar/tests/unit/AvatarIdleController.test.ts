import { describe, expect, it } from 'vitest';
import {
  AvatarIdleController,
  BLINK_TIMING,
  GAZE,
  HEAD_MOTION,
  type BlinkPhase,
  type IdleConfig,
} from '../../src/avatar/AvatarIdleController';

/** Deterministic PRNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function make(config: Partial<IdleConfig> = {}, seed = 1) {
  return new AvatarIdleController({ config: { doubleBlinkChance: 0, ...config }, random: seeded(seed) });
}

function run(ctrl: AvatarIdleController, frames: number, dt: number) {
  for (let i = 0; i < frames; i++) ctrl.update(dt);
  return ctrl.state;
}

describe('breathing', () => {
  it('depends on delta time, not on update calls', () => {
    const ctrl = make();
    ctrl.update(0);
    ctrl.update(0);
    expect(ctrl.state.breath).toBe(0);
    ctrl.update(0.5);
    // 0.25 Hz → quarter period = 1s; after 0.5s: sin(π/4)
    expect(ctrl.state.breath).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    ctrl.update(0.5);
    expect(ctrl.state.breath).toBeCloseTo(1, 6);
  });

  it('scales with intensity and clamps rate into the natural range', () => {
    const ctrl = make({ breathingIntensity: 0.5, breathingRate: 10 });
    ctrl.update(1 / (4 * 0.35));
    expect(ctrl.state.breath).toBeCloseTo(0.5, 6);
  });

  it('ignores negative / NaN deltas', () => {
    const ctrl = make();
    ctrl.update(-1);
    ctrl.update(Number.NaN);
    expect(ctrl.state.time).toBe(0);
  });
});

describe('blink state machine', () => {
  it('goes open → closing → closed → opening → open and returns to 0', () => {
    const ctrl = make({ blinkIntervalMin: 2, blinkIntervalMax: 2 });
    const seen: BlinkPhase[] = [ctrl.state.blinkPhase];
    let maxBlink = 0;
    const dt = 0.005;
    for (let t = 0; t < 2.5; t += dt) {
      ctrl.update(dt);
      maxBlink = Math.max(maxBlink, ctrl.state.blink);
      if (seen[seen.length - 1] !== ctrl.state.blinkPhase) seen.push(ctrl.state.blinkPhase);
    }
    expect(seen).toEqual(['open', 'closing', 'closed', 'opening', 'open']);
    expect(maxBlink).toBe(1);
    expect(ctrl.state.blink).toBe(0);
  });

  it('blink is smooth: bounded change per 5ms step', () => {
    const ctrl = make({ blinkIntervalMin: 0.5, blinkIntervalMax: 0.5 });
    let prev = 0;
    let maxStep = 0;
    for (let i = 0; i < 400; i++) {
      ctrl.update(0.005);
      maxStep = Math.max(maxStep, Math.abs(ctrl.state.blink - prev));
      prev = ctrl.state.blink;
    }
    // smoothstep peak slope is 1.5 / duration
    expect(maxStep).toBeLessThanOrEqual((1.5 * 0.005) / BLINK_TIMING.close + 1e-9);
  });

  it('uses randomized intervals within [min, max]', () => {
    const ctrl = make({ blinkIntervalMin: 2, blinkIntervalMax: 6 }, 42);
    const starts: number[] = [];
    let prev: BlinkPhase = 'open';
    const dt = 0.01;
    for (let i = 0; i < 6000; i++) {
      ctrl.update(dt);
      if (prev === 'open' && ctrl.state.blinkPhase === 'closing') starts.push(ctrl.state.time);
      prev = ctrl.state.blinkPhase;
    }
    const cycle = BLINK_TIMING.close + BLINK_TIMING.hold + BLINK_TIMING.open;
    const gaps = starts.slice(1).map((s, i) => s - starts[i]! - cycle);
    expect(gaps.length).toBeGreaterThan(8);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(2 - 0.02);
      expect(g).toBeLessThanOrEqual(6 + 0.02);
    }
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('handles a delta larger than a whole blink', () => {
    const ctrl = make({ blinkIntervalMin: 1, blinkIntervalMax: 1 });
    ctrl.update(1.02);
    expect(ctrl.state.blinkPhase).toBe('closing');
    ctrl.update(0.5);
    expect(ctrl.state.blinkPhase).toBe('open');
    expect(ctrl.state.blink).toBe(0);
  });

  it('does not blink when blinkEnabled is false', () => {
    const ctrl = make({ blinkEnabled: false, blinkIntervalMin: 0.5, blinkIntervalMax: 0.5 });
    const s = run(ctrl, 600, 1 / 60);
    expect(s.blinkPhase).toBe('open');
    expect(s.blink).toBe(0);
  });
});

describe('enable / disable', () => {
  it('fades every output to neutral when disabled', () => {
    const ctrl = make({ blinkIntervalMin: 0.3, blinkIntervalMax: 0.3 });
    run(ctrl, 120, 1 / 60);
    ctrl.config.enabled = false;
    const s = run(ctrl, 180, 1 / 60);
    expect(s.weight).toBe(0);
    expect(s.breath).toBeCloseTo(0, 12);
    expect(s.headYaw).toBeCloseTo(0, 12);
    expect(s.headPitch).toBeCloseTo(0, 12);
    expect(s.headRoll).toBeCloseTo(0, 12);
    expect(s.blink).toBe(0);
    expect(Math.abs(s.gazeYaw)).toBeLessThan(1e-3);
    expect(Math.abs(s.gazePitch)).toBeLessThan(1e-3);
  });

  it('starts neutral when constructed disabled', () => {
    const ctrl = make({ enabled: false });
    const s = run(ctrl, 60, 1 / 60);
    expect(s.breath).toBeCloseTo(0, 12);
    expect(s.headYaw).toBeCloseTo(0, 12);
  });

  it('pushes the pose into the sink', () => {
    const received: number[] = [];
    const ctrl = new AvatarIdleController({ sink: { setProcedural: (p) => void received.push(p.breath) } });
    ctrl.update(0.1);
    expect(received).toHaveLength(1);
  });
});

describe('head and eye motion bounds', () => {
  it('head motion stays within configured amplitudes', () => {
    for (const seed of [1, 2, 3]) {
      const ctrl = make({}, seed);
      let maxYaw = 0;
      let maxPitch = 0;
      let maxRoll = 0;
      for (let i = 0; i < 60 * 120; i++) {
        const s = ctrl.update(1 / 60);
        maxYaw = Math.max(maxYaw, Math.abs(s.headYaw));
        maxPitch = Math.max(maxPitch, Math.abs(s.headPitch));
        maxRoll = Math.max(maxRoll, Math.abs(s.headRoll));
      }
      expect(maxYaw).toBeLessThanOrEqual(HEAD_MOTION.yaw.amplitude);
      expect(maxPitch).toBeLessThanOrEqual(HEAD_MOTION.pitch.amplitude);
      expect(maxRoll).toBeLessThanOrEqual(HEAD_MOTION.roll.amplitude);
      expect(maxYaw).toBeGreaterThan(0); // not a statue
    }
  });

  it('head motion scales with intensity', () => {
    const ctrl = make({ headMotionIntensity: 0.25 });
    for (let i = 0; i < 60 * 60; i++) {
      const s = ctrl.update(1 / 60);
      expect(Math.abs(s.headYaw)).toBeLessThanOrEqual(HEAD_MOTION.yaw.amplitude * 0.25 + 1e-12);
    }
  });

  it('gaze stays small and is centered most of the time', () => {
    const ctrl = make({}, 7);
    let centered = 0;
    let maxYaw = 0;
    const frames = 60 * 120;
    for (let i = 0; i < frames; i++) {
      const s = ctrl.update(1 / 60);
      maxYaw = Math.max(maxYaw, Math.abs(s.gazeYaw));
      if (s.gazePhase === 'center') centered++;
    }
    expect(maxYaw).toBeLessThanOrEqual(GAZE.maxYaw);
    expect(maxYaw).toBeGreaterThan(0);
    expect(centered / frames).toBeGreaterThan(0.6);
  });
});

describe('time independence', () => {
  const pick = (c: AvatarIdleController) => {
    const s = c.state;
    return [s.breath, s.headYaw, s.headPitch, s.headRoll, s.blink, s.gazeYaw, s.gazePitch];
  };

  it('60 × 16.6ms ≈ 30 × 33.3ms after ~1s', () => {
    const a = make({}, 5);
    const b = make({}, 5);
    run(a, 60, 0.0166);
    run(b, 30, 0.0333);
    const pa = pick(a);
    const pb = pick(b);
    // Total simulated time differs by 3ms (0.996 vs 0.999s)
    expect(Math.abs(a.state.time - b.state.time)).toBeLessThan(0.004);
    pa.forEach((v, i) => expect(v).toBeCloseTo(pb[i]!, 2));
  });

  it('30 / 60 / 120 FPS agree across blinks and gaze switches', () => {
    const fps = [30, 60, 120];
    const ctrls = fps.map(() => make({ blinkIntervalMin: 1, blinkIntervalMax: 3 }, 9));
    ctrls.forEach((c, i) => run(c, fps[i]! * 10, 1 / fps[i]!));
    const ref = pick(ctrls[1]!);
    for (const c of ctrls) {
      expect(c.state.blinkPhase).toBe(ctrls[1]!.state.blinkPhase);
      pick(c).forEach((v, i) => expect(v).toBeCloseTo(ref[i]!, 4));
    }
  });
});
