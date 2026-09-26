import { describe, expect, it } from 'vitest';
import { Avatar } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AmplitudeLipSync } from '../../src/audio/AmplitudeLipSync';
import { FrameMouthSource } from '../../src/audio/FrameMouthSource';
import { isLipSyncFrame, sampleLipSyncFrame, type LipSyncFrame } from '../../src/audio/LipSyncFrame';
import { VisemeLipSync } from '../../src/audio/VisemeLipSync';
import { createFakeVrm, silentLogger } from './fakeVrm';

const frame = (visemes: Partial<LipSyncFrame['visemes']>, volume = 0.5): LipSyncFrame => ({
  active: volume > 0,
  volume,
  visemes: { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, ...visemes },
});

describe('sampleLipSyncFrame', () => {
  it('captures the lip-sync output as a plain serialisable object', () => {
    let rms = 0.1; // -20 dBFS: nearly full open with the defaults
    const lipSync = new VisemeLipSync(new AmplitudeLipSync(() => rms));
    let f = sampleLipSyncFrame(lipSync, 0.5);
    expect(f.active).toBe(true);
    expect(f.volume).toBeGreaterThan(0.5);
    expect(f.visemes.aa).toBeGreaterThan(0.5);
    expect(isLipSyncFrame(structuredClone(f))).toBe(true);

    rms = 0;
    f = sampleLipSyncFrame(lipSync, 1);
    expect(f).toMatchObject({ active: false, volume: 0 });
    expect(f.visemes.aa).toBeLessThan(0.01);
  });
});

describe('isLipSyncFrame', () => {
  it('accepts a valid frame and rejects off-contract values', () => {
    expect(isLipSyncFrame(frame({ aa: 1 }))).toBe(true);
    expect(isLipSyncFrame(null)).toBe(false);
    expect(isLipSyncFrame({ ...frame({}), active: 'yes' })).toBe(false);
    expect(isLipSyncFrame({ ...frame({}), volume: 2 })).toBe(false);
    expect(isLipSyncFrame({ ...frame({}), visemes: { aa: 0.5 } })).toBe(false);
    expect(isLipSyncFrame({ ...frame({}), visemes: { ...frame({}).visemes, ou: Number.NaN } })).toBe(false);
  });
});

describe('FrameMouthSource', () => {
  it('drives the avatar mouth through the existing controller pipeline', () => {
    const vrm = createFakeVrm();
    const controller = new AvatarController({ avatar: new Avatar(vrm, { logger: silentLogger() }) });
    const source = new FrameMouthSource();
    controller.setMouthSource(source);

    source.push(frame({ ou: 0.6, aa: 0.2 }));
    for (let i = 0; i < 12; i++) controller.update(1 / 60);
    expect(vrm.values.get('ou')).toBeCloseTo(0.6, 2);
    expect(vrm.values.get('aa')).toBeCloseTo(0.2, 2);
  });

  it('interpolates between frames instead of stepping', () => {
    const source = new FrameMouthSource({ smoothing: 0.025 });
    source.push(frame({ aa: 1 }));
    const first = source.update(1 / 60).aa;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(1);
  });

  it('closes the mouth when frames stop arriving', () => {
    const source = new FrameMouthSource({ staleAfter: 0.2 });
    source.push(frame({ aa: 0.8 }));
    for (let i = 0; i < 6; i++) source.update(1 / 60);
    expect(source.value.aa).toBeGreaterThan(0.5);
    for (let i = 0; i < 30; i++) source.update(1 / 60);
    expect(source.frame.active).toBe(false);
    expect(source.value.aa).toBeLessThan(0.01);
  });
});
