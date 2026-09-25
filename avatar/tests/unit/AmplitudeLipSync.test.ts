import { describe, expect, it } from 'vitest';
import { Avatar } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController } from '../../src/avatar/AvatarIdleController';
import { AmplitudeLipSync, follow, mapLevel, MIN_DB, toDb } from '../../src/audio/AmplitudeLipSync';
import { createFakeVrm, silentLogger } from './fakeVrm';

/** RMS signal driven by a test-controlled variable. */
function signal(initial = 0) {
  const s = { rms: initial, read: () => s.rms };
  return s;
}

function run(source: { update(dt: number): number }, seconds: number, dt: number): number {
  let v = 0;
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) v = source.update(dt);
  return v;
}

const dbToRms = (db: number) => 10 ** (db / 20);

describe('level mapping', () => {
  it('converts RMS to dBFS and clamps silence', () => {
    expect(toDb(1)).toBeCloseTo(0);
    expect(toDb(0.1)).toBeCloseTo(-20);
    expect(toDb(0)).toBe(MIN_DB);
    expect(toDb(NaN)).toBe(MIN_DB);
  });

  it('is linear in dB between floor and full, clamped outside', () => {
    expect(mapLevel(-60, -50, -20)).toBe(0);
    expect(mapLevel(-50, -50, -20)).toBe(0);
    expect(mapLevel(-35, -50, -20)).toBeCloseTo(0.5);
    expect(mapLevel(-20, -50, -20)).toBe(1);
    expect(mapLevel(0, -50, -20)).toBe(1);
    // Degenerate range acts as a gate instead of dividing by zero.
    expect(mapLevel(-40, -30, -30)).toBe(0);
    expect(mapLevel(-20, -30, -30)).toBe(1);
  });
});

describe('attack / release follower', () => {
  it('reaches 1 - 1/e of a step after one time constant', () => {
    expect(follow(0, 1, 0.03, 0.03, 0.1)).toBeCloseTo(1 - Math.exp(-1));
    expect(follow(1, 0, 0.1, 0.03, 0.1)).toBeCloseTo(Math.exp(-1));
  });

  it('uses attack when rising and release when falling', () => {
    const rise = follow(0, 1, 0.02, 0.02, 0.2);
    const fall = 1 - follow(1, 0, 0.02, 0.02, 0.2);
    expect(rise).toBeGreaterThan(fall * 5);
  });

  it('ignores non-positive delta and snaps with zero time constant', () => {
    expect(follow(0.3, 1, 0, 0.03, 0.1)).toBe(0.3);
    expect(follow(0.3, 1, -1, 0.03, 0.1)).toBe(0.3);
    expect(follow(0.3, 1, 0.016, 0, 0.1)).toBe(1);
  });
});

describe('AmplitudeLipSync', () => {
  const config = { noiseFloorDb: -50, fullOpenDb: -20, attack: 0.03, release: 0.1, maxOpen: 1, gainDb: 0 };

  it('stays closed on silence and below the noise floor', () => {
    const s = signal(0);
    const lip = new AmplitudeLipSync(s.read, config);
    expect(run(lip, 1, 1 / 60)).toBe(0);
    s.rms = dbToRms(-55);
    expect(run(lip, 1, 1 / 60)).toBe(0);
  });

  it('opens on a loud signal and closes after it stops', () => {
    const s = signal(dbToRms(-10));
    const lip = new AmplitudeLipSync(s.read, config);
    expect(run(lip, 0.2, 1 / 60)).toBeGreaterThan(0.99);
    s.rms = 0;
    expect(run(lip, 0.1, 1 / 60)).toBeCloseTo(Math.exp(-1), 2);
    expect(run(lip, 0.5, 1 / 60)).toBeLessThan(0.01);
  });

  it('opens faster than it closes with default-like settings', () => {
    const s = signal(dbToRms(-10));
    const lip = new AmplitudeLipSync(s.read, config);
    const opened = run(lip, 0.05, 1 / 60);
    lip.update(0); // no-op
    s.rms = 0;
    const closedBy = opened - run(lip, 0.05, 1 / 60);
    expect(opened).toBeGreaterThan(closedBy);
  });

  it('applies gain and maxOpen', () => {
    const s = signal(dbToRms(-45));
    const quiet = new AmplitudeLipSync(s.read, config);
    const boosted = new AmplitudeLipSync(s.read, { ...config, gainDb: 20 });
    expect(run(boosted, 1, 1 / 60)).toBeGreaterThan(run(quiet, 1, 1 / 60) + 0.5);
    expect(boosted.levelDb).toBeCloseTo(-25);

    const capped = new AmplitudeLipSync(signal(1).read, { ...config, maxOpen: 0.6 });
    expect(run(capped, 1, 1 / 60)).toBeCloseTo(0.6);
  });

  it('is frame-rate independent for the same input over time', () => {
    // Speech-like on/off envelope. Edges sit on frame boundaries of every tested rate: the follower is exact
    // for piecewise-constant input, while an edge inside a frame is inherently quantised to that frame.
    const envelopeDb = (t: number) => (Math.floor(t / 0.2 + 1e-9) % 3 === 2 ? -80 : -25);
    const simulate = (fps: number) => {
      let t = 0;
      const lip = new AmplitudeLipSync(() => dbToRms(envelopeDb(t)), config);
      const dt = 1 / fps;
      const samples: number[] = [];
      for (let i = 0; i < fps * 2; i++) {
        t = i * dt; // level at the start of the frame, held for the frame
        lip.update(dt);
        if ((i + 1) % (fps / 10) === 0) samples.push(lip.value);
      }
      return samples;
    };
    const a = simulate(30);
    const b = simulate(60);
    const c = simulate(120);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i]!, 6);
      expect(c[i]).toBeCloseTo(b[i]!, 6);
    }
  });

  it('disabled lip sync decays to closed', () => {
    const lip = new AmplitudeLipSync(signal(1).read, config);
    run(lip, 0.5, 1 / 60);
    lip.config.enabled = false;
    expect(run(lip, 1, 1 / 60)).toBeLessThan(0.001);
  });
});

describe('mouth composition', () => {
  function setup() {
    const vrm = createFakeVrm();
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    const controller = new AvatarController({ avatar, idle: new AvatarIdleController({ config: { blinkEnabled: false } }) });
    return { vrm, avatar, controller };
  }

  it('drives "aa" from the mouth source through the controller', () => {
    const { vrm, controller } = setup();
    let open = 0.7;
    controller.setMouthSource({ update: () => open });
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBeCloseTo(0.7);
    open = 0;
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBe(0);
  });

  it('combines with the manual "aa" via max and leaves other visemes alone', () => {
    const { vrm, controller } = setup();
    controller.setMouthSource({ update: () => 0.3 });
    controller.setExpression('aa', 0.5);
    controller.setExpression('oh', 0.4);
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBeCloseTo(0.5);
    expect(vrm.values.get('oh')).toBeCloseTo(0.4);
    controller.setExpression('aa', 0.1);
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBeCloseTo(0.3);
  });

  it('clamps out-of-range source values and closes when the source is removed', () => {
    const { vrm, controller } = setup();
    controller.setMouthSource({ update: () => 4 });
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBe(1);
    controller.setMouthSource(null);
    controller.update(1 / 60);
    expect(vrm.values.get('aa')).toBe(0);
  });

  it('receives the frame delta', () => {
    const { controller } = setup();
    const deltas: number[] = [];
    controller.setMouthSource({ update: (dt) => (deltas.push(dt), 0) });
    controller.update(0.016);
    controller.update(0.033);
    expect(deltas).toEqual([0.016, 0.033]);
  });
});
