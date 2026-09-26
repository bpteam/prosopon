import { describe, expect, it } from 'vitest';
import { PitchBaseline } from '../../src/audio/user/PitchBaseline';
import { PitchDetector } from '../../src/audio/user/PitchDetector';
import { UserVoiceAnalyzer } from '../../src/audio/user/UserVoiceAnalyzer';
import { SILENT_USER_VOICE_FRAME, isUserVoiceFrame } from '../../src/audio/user/UserVoiceFrame';
import { VoiceActivityDetector } from '../../src/audio/user/VoiceActivityDetector';

const SR = 48000;

/** Deterministic pseudo-random noise. */
function rng(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

type Segment = { kind: 'silence' | 'speech' | 'sine'; seconds: number; hz?: number; amp?: number };

/**
 * Background noise at ~-66 dBFS plus segments of "speech": a band-limited buzz with a syllable-rate envelope that
 * never drops to zero inside the segment, or a pure sine.
 */
function signal(segments: Segment[], sr = SR): Float32Array {
  const total = Math.round(segments.reduce((a, s) => a + s.seconds, 0) * sr);
  const out = new Float32Array(total);
  const noise = rng(7);
  let i = 0;
  let lp = 0;
  for (const seg of segments) {
    const n = Math.round(seg.seconds * sr);
    const hz = seg.hz ?? 150;
    const amp = seg.amp ?? 0.25;
    for (let k = 0; k < n; k++, i++) {
      const t = k / sr;
      let v = noise() * 0.002;
      if (seg.kind === 'speech') {
        const phase = (t * hz) % 1;
        const saw = 2 * phase - 1;
        lp += (saw - lp) * 0.2;
        const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
        v += lp * amp * env;
      } else if (seg.kind === 'sine') {
        v += Math.sin(2 * Math.PI * hz * t) * amp;
      }
      out[i] = v;
    }
  }
  return out;
}

/** Runs the analyser over `samples` in chunks of `chunk` and records VAD edges with their analysis times. */
function edges(samples: Float32Array, chunk: number): { t: number; speaking: boolean }[] {
  const a = new UserVoiceAnalyzer(SR);
  const out: { t: number; speaking: boolean }[] = [];
  let was = false;
  for (let i = 0; i < samples.length; i += chunk) {
    a.process(samples.subarray(i, Math.min(samples.length, i + chunk)));
    const s = a.activity.speaking;
    if (s !== was) {
      out.push({ t: Math.min(samples.length, i + chunk) / SR, speaking: s });
      was = s;
    }
  }
  return out;
}

describe('VoiceActivityDetector', () => {
  const HOP = 0.01;
  const run = (vad: VoiceActivityDetector, db: number, seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += HOP) vad.process(db, HOP);
    return vad.state;
  };

  it('silence → not speaking', () => {
    const vad = new VoiceActivityDetector();
    expect(run(vad, -70, 2).speaking).toBe(false);
  });

  it('a short spike does not start speech', () => {
    const vad = new VoiceActivityDetector();
    run(vad, -70, 1);
    expect(run(vad, -20, 0.05).speaking).toBe(false);
    expect(run(vad, -70, 0.5).speaking).toBe(false);
  });

  it('sustained speech-like energy → speaking, with the start dated back to the onset', () => {
    const vad = new VoiceActivityDetector();
    run(vad, -70, 1);
    const s = run(vad, -30, 0.3);
    expect(s.speaking).toBe(true);
    expect(s.startedAt).toBeCloseTo(1, 1);
    expect(s.duration).toBeGreaterThan(0.25);
  });

  it('a short gap keeps speaking (hangover)', () => {
    const vad = new VoiceActivityDetector();
    run(vad, -70, 1);
    run(vad, -30, 0.5);
    expect(run(vad, -70, 0.15).speaking).toBe(true);
    expect(run(vad, -30, 0.3).speaking).toBe(true);
  });

  it('a long silence ends speech and reports the finished segment length', () => {
    const vad = new VoiceActivityDetector();
    run(vad, -70, 1);
    run(vad, -30, 0.8);
    const s = run(vad, -70, 0.6);
    expect(s.speaking).toBe(false);
    expect(s.startedAt).toBeNull();
    expect(s.duration).toBeCloseTo(0.8, 1);
  });

  it('does not flap on a level that hovers at the threshold (hysteresis)', () => {
    const vad = new VoiceActivityDetector();
    run(vad, -70, 1);
    run(vad, -40, 0.3); // speaking: 30 dB above the floor
    let flips = 0;
    let was = vad.speaking;
    // Alternate around floor+activation: above deactivation the whole time, so it must stay on.
    for (let i = 0; i < 200; i++) {
      vad.process(i % 2 ? -57 : -59, HOP);
      if (vad.speaking !== was) flips++;
      was = vad.speaking;
    }
    expect(flips).toBe(0);
  });

  it('a constant loud noise does not freeze speech on forever: the floor eventually catches up', () => {
    const vad = new VoiceActivityDetector();
    run(vad, -70, 1);
    expect(run(vad, -45, 1).speaking).toBe(true);
    expect(run(vad, -45, 60).speaking).toBe(false);
  });
});

describe('UserVoiceAnalyzer VAD is chunk-size independent', () => {
  const samples = signal([
    { kind: 'silence', seconds: 1 },
    { kind: 'speech', seconds: 1.2 },
    { kind: 'silence', seconds: 0.15 }, // gap shorter than hangover
    { kind: 'speech', seconds: 0.6 },
    { kind: 'silence', seconds: 1.5 },
  ]);

  it('10, 20 and 40 ms chunks give the same transitions within one chunk', () => {
    const a = edges(samples, 480);
    const b = edges(samples, 960);
    const c = edges(samples, 1920);
    expect(a.map((e) => e.speaking)).toEqual([true, false]);
    expect(b.map((e) => e.speaking)).toEqual(a.map((e) => e.speaking));
    expect(c.map((e) => e.speaking)).toEqual(a.map((e) => e.speaking));
    for (let i = 0; i < a.length; i++) {
      expect(Math.abs(a[i]!.t - b[i]!.t)).toBeLessThanOrEqual(0.04);
      expect(Math.abs(a[i]!.t - c[i]!.t)).toBeLessThanOrEqual(0.04);
    }
    // Onset ≈ 1 s + attack; end ≈ 2.95 s + hangover.
    expect(a[0]!.t).toBeGreaterThan(1.05);
    expect(a[0]!.t).toBeLessThan(1.25);
    expect(a[1]!.t).toBeGreaterThan(3.1);
    expect(a[1]!.t).toBeLessThan(3.4);
  });

  it('odd chunk sizes (128-sample render quanta, 1 sample) change nothing', () => {
    const ref = edges(samples, 480).map((e) => e.speaking);
    expect(edges(samples, 128).map((e) => e.speaking)).toEqual(ref);
    expect(edges(samples.subarray(0, SR * 2), 1).map((e) => e.speaking)).toEqual([true]);
  });
});

describe('PitchDetector', () => {
  const detector = new PitchDetector();
  const sine = (hz: number, sr: number, n: number) =>
    Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / sr));

  it.each([110, 220, 440])('finds %d Hz in a sine within 1%%', (hz) => {
    const sr = 16000;
    const est = detector.detect(sine(hz, sr, PitchDetector.windowFor(sr)), sr);
    expect(est.hz).not.toBeNull();
    expect(Math.abs(est.hz! - hz) / hz).toBeLessThan(0.01);
    expect(est.confidence).toBeGreaterThan(0.9);
  });

  it('silence → null pitch, zero confidence', () => {
    const est = detector.detect(new Float32Array(1000), 16000);
    expect(est).toEqual({ hz: null, confidence: 0 });
  });

  it('white noise → null pitch', () => {
    const r = rng(3);
    const est = detector.detect(Float32Array.from({ length: 534 }, () => r() * 0.5), 16000);
    expect(est.hz).toBeNull();
  });

  it('a harmonic-rich buzz does not jump an octave down', () => {
    const sr = 16000;
    const s = signal([{ kind: 'speech', seconds: 0.05, hz: 180, amp: 0.4 }], sr);
    const est = detector.detect(s.subarray(s.length - PitchDetector.windowFor(sr)), sr);
    expect(est.hz).not.toBeNull();
    expect(Math.abs(est.hz! - 180) / 180).toBeLessThan(0.03);
  });
});

describe('PitchBaseline', () => {
  it('200 Hz baseline: 200 Hz → 0 st, 400 Hz → +12 st, 100 Hz → -12 st', () => {
    const b = new PitchBaseline();
    b.set(200);
    expect(b.relative(200)).toBeCloseTo(0, 6);
    expect(b.relative(400)).toBeCloseTo(12, 6);
    expect(b.relative(100)).toBeCloseTo(-12, 6);
  });

  it('warms up from the median of voiced frames, then adapts slowly', () => {
    const b = new PitchBaseline();
    for (let i = 0; i < 75; i++) b.add(i === 10 ? 800 : 200, 0.02); // 1.5 s, one outlier
    expect(b.hz).toBeCloseTo(200, 3);
    // Two seconds of a raised voice barely move it: the relative signal survives a phrase.
    for (let i = 0; i < 100; i++) b.add(300, 0.02);
    expect(b.hz!).toBeLessThan(215);
    expect(b.relative(300)).toBeGreaterThan(5.5);
  });

  it('reports 0 before a baseline exists', () => {
    expect(new PitchBaseline().relative(300)).toBe(0);
  });
});

describe('UserVoiceAnalyzer frames', () => {
  it('speech → speaking, energy, pitch near F0, confident; silence → null pitch, no energy', () => {
    const a = new UserVoiceAnalyzer(SR);
    a.process(signal([{ kind: 'silence', seconds: 1 }, { kind: 'speech', seconds: 2.5, hz: 160 }]));
    const f = a.frame();
    expect(isUserVoiceFrame(f)).toBe(true);
    expect(f.speaking).toBe(true);
    expect(f.energy).toBeGreaterThan(0.2);
    expect(f.pitchHz).not.toBeNull();
    expect(Math.abs(f.pitchHz! - 160)).toBeLessThan(5);
    expect(f.pitchConfidence).toBeGreaterThan(0.8);
    // Baseline was learned from the same voice.
    expect(Math.abs(f.relativePitch)).toBeLessThan(0.5);

    a.process(signal([{ kind: 'silence', seconds: 1 }]));
    const s = a.frame();
    expect(s.speaking).toBe(false);
    expect(s.pitchHz).toBeNull();
    expect(s.energy).toBe(0);
    expect(s.segmentDuration).toBeGreaterThan(2.3);
  });

  it('a raised voice reads as positive relative pitch against the learned baseline', () => {
    const a = new UserVoiceAnalyzer(SR);
    a.process(signal([{ kind: 'silence', seconds: 0.5 }, { kind: 'speech', seconds: 3, hz: 150 }, { kind: 'silence', seconds: 0.5 }]));
    a.process(signal([{ kind: 'speech', seconds: 0.6, hz: 212 }]));
    expect(a.frame().relativePitch).toBeGreaterThan(5);
  });

  it('reset() clears VAD, baseline and frame', () => {
    const a = new UserVoiceAnalyzer(SR);
    a.process(signal([{ kind: 'silence', seconds: 0.5 }, { kind: 'speech', seconds: 2.5 }]));
    a.reset();
    expect(a.baseline.hz).toBeNull();
    expect(a.frame()).toEqual({ ...SILENT_USER_VOICE_FRAME, noiseFloorDb: a.vad.config.minFloorDb });
  });
});

describe('isUserVoiceFrame', () => {
  it('accepts the silent frame and rejects buffers, extra fields and out-of-range values', () => {
    expect(isUserVoiceFrame({ ...SILENT_USER_VOICE_FRAME })).toBe(true);
    expect(isUserVoiceFrame({ ...SILENT_USER_VOICE_FRAME, pcm: new Float32Array(4) })).toBe(false);
    expect(isUserVoiceFrame({ ...SILENT_USER_VOICE_FRAME, rmsDb: new ArrayBuffer(8) })).toBe(false);
    expect(isUserVoiceFrame({ ...SILENT_USER_VOICE_FRAME, energy: 2 })).toBe(false);
    expect(isUserVoiceFrame({ ...SILENT_USER_VOICE_FRAME, pitchHz: 0 })).toBe(false);
    expect(isUserVoiceFrame(null)).toBe(false);
  });
});
