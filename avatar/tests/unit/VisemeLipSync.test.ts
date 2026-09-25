import { describe, expect, it } from 'vitest';
import { Avatar, CLOSED_MOUTH, type MouthShape } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController } from '../../src/avatar/AvatarIdleController';
import { AmplitudeLipSync } from '../../src/audio/AmplitudeLipSync';
import { OCULUS_TO_VRM, HeadAudioAnalyzer } from '../../src/audio/analyzers/HeadAudioAnalyzer';
import { mapWeights } from '../../src/audio/analyzers/WLipSyncAnalyzer';
import type { AudioInput } from '../../src/audio/AudioInput';
import { writeShape, type VisemeAnalyzer, type VisemeAnalyzerFactory } from '../../src/audio/VisemeAnalyzer';
import { VisemeAnalyzerHost } from '../../src/audio/VisemeAnalyzerHost';
import { VisemeLipSync } from '../../src/audio/VisemeLipSync';
import { createFakeVrm, silentLogger } from './fakeVrm';

const LOUD = 10 ** (-18 / 20); // at fullOpenDb
const HALF = 10 ** (-34 / 20); // halfway between -50 and -18 dBFS

/** Analyser whose shape and health are set by the test. */
function fakeAnalyzer(shape: Partial<MouthShape> = {}) {
  const a = {
    name: 'headaudio' as const,
    input: {} as AudioNode,
    healthy: true,
    shape,
    disposed: false,
    read(out: MouthShape) {
      writeShape(out, a.shape);
    },
    dispose() {
      a.disposed = true;
    },
  };
  return a;
}

function setup(rms = LOUD) {
  const signal = { rms };
  const amplitude = new AmplitudeLipSync(() => signal.rms);
  const lipSync = new VisemeLipSync(amplitude);
  return { signal, amplitude, lipSync };
}

function run(lipSync: VisemeLipSync, seconds: number, dt: number): Readonly<MouthShape> {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) lipSync.update(dt);
  return lipSync.value;
}

describe('VisemeLipSync', () => {
  it('is plain amplitude "aa" without an analyser', () => {
    const { lipSync, amplitude } = setup();
    const out = run(lipSync, 1, 1 / 60);
    expect(lipSync.mode).toBe('amplitude');
    expect(out.aa).toBeCloseTo(amplitude.value, 6);
    expect(out.aa).toBeGreaterThan(0.7);
    expect(out.oh + out.ee + out.ih + out.ou).toBe(0);
  });

  it('crossfades to the analyser shape and scales it by maxOpen at full level', () => {
    const { lipSync } = setup();
    run(lipSync, 1, 1 / 60);
    lipSync.setAnalyzer(fakeAnalyzer({ oh: 1 }));
    expect(lipSync.mode).toBe('viseme');

    const early = run(lipSync, 0.05, 1 / 60);
    expect(early.aa).toBeGreaterThan(0.2); // still fading out
    expect(early.oh).toBeGreaterThan(0);

    const out = run(lipSync, 2, 1 / 60);
    expect(lipSync.visemeWeight).toBeCloseTo(1, 3);
    expect(out.oh).toBeCloseTo(0.8, 2);
    expect(out.aa).toBeLessThan(0.01);
  });

  it('opens less for quieter speech according to levelInfluence', () => {
    const { lipSync, amplitude } = setup(HALF);
    lipSync.setAnalyzer(fakeAnalyzer({ ee: 1 }));
    lipSync.config.levelInfluence = 1;
    expect(run(lipSync, 2, 1 / 60).ee).toBeCloseTo(amplitude.targetValue, 3);
    lipSync.config.levelInfluence = 0;
    expect(run(lipSync, 2, 1 / 60).ee).toBeCloseTo(0.8, 3);
  });

  it('closes on silence even if the analyser still reports a vowel', () => {
    const { lipSync, signal } = setup();
    lipSync.setAnalyzer(fakeAnalyzer({ aa: 1 }));
    run(lipSync, 1, 1 / 60);
    signal.rms = 0;
    const out = run(lipSync, 1, 1 / 60);
    for (const v of Object.values(out)) expect(v).toBeLessThan(1e-3);
  });

  it('closes on bilabials while loud', () => {
    const { lipSync } = setup();
    const analyzer = fakeAnalyzer({ aa: 1 });
    lipSync.setAnalyzer(analyzer);
    run(lipSync, 1, 1 / 60);
    analyzer.shape = OCULUS_TO_VRM.viseme_PP!;
    expect(run(lipSync, 0.5, 1 / 60).aa).toBeLessThan(0.01);
  });

  it('falls back to amplitude when the analyser fails or is disabled', () => {
    const { lipSync, amplitude } = setup();
    const analyzer = fakeAnalyzer({ ou: 1 });
    lipSync.setAnalyzer(analyzer);
    run(lipSync, 1, 1 / 60);

    analyzer.healthy = false;
    expect(lipSync.mode).toBe('amplitude');
    let out = run(lipSync, 2, 1 / 60);
    expect(out.aa).toBeCloseTo(amplitude.value, 3);
    expect(out.ou).toBeLessThan(0.01);

    analyzer.healthy = true;
    lipSync.config.enabled = false;
    out = run(lipSync, 2, 1 / 60);
    expect(out.ou).toBeLessThan(0.01);
  });

  it('is frame-rate independent', () => {
    const results = [1 / 30, 1 / 60, 1 / 120].map((dt) => {
      const { lipSync } = setup();
      const analyzer = fakeAnalyzer({ aa: 1 });
      lipSync.setAnalyzer(analyzer);
      run(lipSync, 0.1, dt);
      analyzer.shape = { oh: 1 };
      return { ...run(lipSync, 0.1, dt) };
    });
    for (const r of results.slice(1)) {
      expect(r.aa).toBeCloseTo(results[0]!.aa, 6);
      expect(r.oh).toBeCloseTo(results[0]!.oh, 6);
    }
  });

  it('drives the VRM viseme presets through the controller', () => {
    const vrm = createFakeVrm({ expressions: ['blink', 'aa', 'ih', 'ou', 'ee', 'oh'] });
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    const controller = new AvatarController({ avatar, idle: new AvatarIdleController({ config: { blinkEnabled: false } }) });
    const { lipSync } = setup();
    lipSync.setAnalyzer(fakeAnalyzer({ ih: 0.5, ou: 0.5 }));
    controller.setMouthSource(lipSync);
    for (let i = 0; i < 120; i++) controller.update(1 / 60);
    expect(vrm.values.get('ih')).toBeCloseTo(0.4, 2);
    expect(vrm.values.get('ou')).toBeCloseTo(0.4, 2);
    expect(vrm.values.get('aa')).toBeLessThan(0.01);
    controller.setExpression('ih', 0.9);
    controller.update(1 / 60);
    expect(vrm.values.get('ih')).toBeCloseTo(0.9);
  });
});

describe('analyser mappings', () => {
  it('maps every HeadAudio viseme to a shape whose weights sum to at most 1', () => {
    const names = ['aa', 'E', 'I', 'O', 'U', 'PP', 'SS', 'TH', 'DD', 'FF', 'kk', 'nn', 'RR', 'CH', 'sil'];
    for (const n of names) {
      const row = OCULUS_TO_VRM[`viseme_${n}`];
      expect(row, n).toBeDefined();
      const sum = Object.values(row!).reduce((a, b) => a + b, 0);
      expect(sum).toBeLessThanOrEqual(1);
    }
  });

  it('reads the active HeadAudio viseme, silence as closed', () => {
    const node = {
      visemeActive: 3,
      visemeNames: ['viseme_aa', 'viseme_E', 'viseme_I', 'viseme_O'],
      addEventListener() {},
      removeEventListener() {},
      stop() {},
      disconnect() {},
    };
    const analyzer = new HeadAudioAnalyzer(node as unknown as ConstructorParameters<typeof HeadAudioAnalyzer>[0]);
    const out = { ...CLOSED_MOUTH };
    analyzer.read(out);
    expect(out).toEqual({ aa: 0, ih: 0, ou: 0, ee: 0, oh: 1 });
    node.visemeActive = -1;
    analyzer.read(out);
    expect(out).toEqual(CLOSED_MOUTH);
  });

  it('blends wLipSync phoneme weights and normalises overshoot', () => {
    const out = { ...CLOSED_MOUTH };
    mapWeights({ A: 0.5, O: 0.25, S: 0 }, out);
    expect(out).toEqual({ aa: 0.5, ih: 0, ou: 0, ee: 0, oh: 0.25 });
    mapWeights({ A: 1.1, I: 0.9 }, out);
    expect(out.aa + out.ih).toBeCloseTo(1);
    expect(out.aa).toBeCloseTo(0.55);
  });
});

describe('VisemeAnalyzerHost', () => {
  function fakeInput() {
    const listeners = new Set<() => void>();
    const input = {
      context: null as AudioContext | null,
      taps: new Set<AudioNode>(),
      onKindChange(l: () => void) {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      addTap(node: AudioNode) {
        input.taps.add(node);
        return () => void input.taps.delete(node);
      },
      start() {
        input.context = {} as AudioContext;
        for (const l of listeners) l();
      },
    };
    return input;
  }

  it('creates the analyser once audio starts, taps it and hands it to lip sync', async () => {
    const input = fakeInput();
    const { lipSync } = setup();
    const analyzer = fakeAnalyzer();
    let calls = 0;
    const factory: VisemeAnalyzerFactory = async () => (calls++, analyzer as VisemeAnalyzer);
    const host = new VisemeAnalyzerHost(input as unknown as AudioInput, lipSync, { headaudio: factory, wlipsync: factory }, 'headaudio');
    expect(host.status).toBe('waits for audio');

    input.start();
    expect(host.status).toBe('loading');
    await host.whenSettled();
    expect(host.status).toBe('ready');
    expect(lipSync.getAnalyzer()).toBe(analyzer);
    expect(input.taps.has(analyzer.input)).toBe(true);

    input.start(); // a new source doesn't recreate it
    expect(calls).toBe(1);

    host.select('none');
    expect(analyzer.disposed).toBe(true);
    expect(input.taps.size).toBe(0);
    expect(lipSync.getAnalyzer()).toBeNull();
    expect(host.status).toBe('off');
  });

  it('stays in amplitude mode and reports the error when creation fails', async () => {
    const input = fakeInput();
    input.start();
    const { lipSync } = setup();
    const failing: VisemeAnalyzerFactory = () => Promise.reject(new Error('no AudioWorklet'));
    const host = new VisemeAnalyzerHost(input as unknown as AudioInput, lipSync, { headaudio: failing, wlipsync: failing }, 'none');
    const warn = console.warn;
    console.warn = () => {};
    try {
      host.select('wlipsync');
      await host.whenSettled();
    } finally {
      console.warn = warn;
    }
    expect(host.status).toBe('error: no AudioWorklet');
    expect(lipSync.mode).toBe('amplitude');
  });

  it('discards an analyser that finishes loading after the choice changed', async () => {
    const input = fakeInput();
    input.start();
    const { lipSync } = setup();
    const slow = fakeAnalyzer();
    let resolve!: (a: VisemeAnalyzer) => void;
    const host = new VisemeAnalyzerHost(
      input as unknown as AudioInput,
      lipSync,
      { headaudio: () => new Promise((r) => (resolve = r)), wlipsync: async () => fakeAnalyzer() as VisemeAnalyzer },
      'headaudio',
    );
    host.select('wlipsync');
    await host.whenSettled();
    resolve(slow as VisemeAnalyzer);
    await Promise.resolve();
    expect(slow.disposed).toBe(true);
    expect(host.analyzer).not.toBe(slow);
    expect(host.selected).toBe('wlipsync');
  });
});
