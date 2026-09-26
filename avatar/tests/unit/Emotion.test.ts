import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_EMOTION,
  isEmotionFrame,
  sanitizeEmotionFrame,
  type EmotionFrame,
} from '../../src/audio/emotion/EmotionFrame';
import { EmotionModelHost } from '../../src/audio/emotion/EmotionModelHost';
import type { EmotionModel, EmotionModelSpec } from '../../src/audio/emotion/EmotionModel';
import { readEstimate } from '../../src/audio/emotion/EmotionModel';
import { ProsodyEmotionAnalyzer } from '../../src/audio/emotion/ProsodyEmotionAnalyzer';
import { UserVoiceAnalyzer } from '../../src/audio/user/UserVoiceAnalyzer';
import { SILENT_USER_VOICE_FRAME, type VoiceFeatureFrame } from '../../src/audio/user/UserVoiceFrame';
import { Avatar, EMPTY_PROCEDURAL_POSE } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController } from '../../src/avatar/AvatarIdleController';
import { STATE_PROFILES } from '../../src/avatar/AvatarStateProfiles';
import { BehaviorMixer, DEFAULT_EMOTION_MIX } from '../../src/avatar/BehaviorMixer';
import { EmotionChannels } from '../../src/avatar/EmotionChannels';
import { EMOTION_EXPRESSIONS, NEUTRAL_EMOTION_INPUTS, type EmotionInputs } from '../../src/avatar/EmotionExpression';
import { createFakeVrm, silentLogger } from './fakeVrm';
import { CALM, EXCITED, concat, rng, silence, voice } from './voiceSignals';

const FRAME_DT = 1 / 25;
const SR = 48000;

/** Feature frames of a signal, as the worklet would post them (25 Hz of audio time). */
function featureFrames(samples: Float32Array): VoiceFeatureFrame[] {
  const a = new UserVoiceAnalyzer(SR);
  const hop = SR * FRAME_DT;
  const out: VoiceFeatureFrame[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    a.process(samples.subarray(i, i + hop));
    out.push(a.frame());
  }
  return out;
}

/** Runs frames through an analyser and returns every emitted EmotionFrame. */
function analyse(p: ProsodyEmotionAnalyzer, frames: VoiceFeatureFrame[]): EmotionFrame[] {
  const out: EmotionFrame[] = [];
  for (const f of frames) {
    const e = p.push(f, FRAME_DT);
    if (e) out.push(e);
  }
  return out;
}

const speech = (over: Partial<VoiceFeatureFrame> = {}): VoiceFeatureFrame => ({
  ...SILENT_USER_VOICE_FRAME,
  speaking: true,
  segmentDuration: 1,
  rmsDb: -25,
  noiseFloorDb: -60,
  energy: 0.5,
  pitchHz: 160,
  pitchConfidence: 0.9,
  relativePitch: 0,
  pitchVariation: 1,
  spectralCentroid: 1200,
  spectralRolloff: 2500,
  zeroCrossingRate: 0.05,
  ...over,
});

const repeat = <T,>(x: T | (() => T), seconds: number): T[] =>
  Array.from({ length: Math.round(seconds / FRAME_DT) }, () => (typeof x === 'function' ? (x as () => T)() : x));

function expectInRange(f: EmotionFrame): void {
  expect(isEmotionFrame(f), JSON.stringify(f)).toBe(true);
  for (const [k, v] of Object.entries(f)) if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true);
  expect(f.valence).toBeGreaterThanOrEqual(-1);
  expect(f.valence).toBeLessThanOrEqual(1);
  for (const k of ['arousal', 'energy', 'confidence', 'tension', 'pitchVariation', 'valenceConfidence'] as const) {
    expect(f[k], k).toBeGreaterThanOrEqual(0);
    expect(f[k], k).toBeLessThanOrEqual(1);
  }
}

describe('EmotionFrame', () => {
  it('all values finite and in range for speech, silence and garbage input', () => {
    const p = new ProsodyEmotionAnalyzer();
    const noise = rng(11);
    const garbage = () =>
      speech({
        energy: noise() * 10,
        rmsDb: noise() > 0.4 ? NaN : noise() * 300,
        relativePitch: noise() > 0.3 ? Infinity : noise() * 100,
        pitchVariation: noise() * 1e6,
        spectralCentroid: noise() > 0.3 ? -Infinity : noise() * 1e5,
        speaking: noise() > 0,
      });
    const frames = [
      ...featureFrames(concat(silence(1), voice(EXCITED), silence(2))),
      ...repeat(garbage, 4),
      ...repeat(SILENT_USER_VOICE_FRAME, 3),
    ];
    const out = analyse(p, frames);
    expect(out.length).toBeGreaterThan(50);
    out.forEach(expectInRange);
  });

  it('isEmotionFrame rejects out-of-range, non-finite and extra fields; sanitize clamps', () => {
    expect(isEmotionFrame(NEUTRAL_EMOTION)).toBe(true);
    expect(isEmotionFrame({ ...NEUTRAL_EMOTION, arousal: 1.2 })).toBe(false);
    expect(isEmotionFrame({ ...NEUTRAL_EMOTION, valence: NaN })).toBe(false);
    expect(isEmotionFrame({ ...NEUTRAL_EMOTION, mode: 'gpt' })).toBe(false);
    expect(isEmotionFrame({ ...NEUTRAL_EMOTION, pcm: [1, 2] })).toBe(false);
    const s = sanitizeEmotionFrame({ ...NEUTRAL_EMOTION, arousal: 5, valence: -Infinity, confidence: 0.3, valenceConfidence: 0.9 });
    expect(s.arousal).toBe(1);
    expect(s.valence).toBe(0);
    expect(s.valenceConfidence).toBe(0.3);
  });
});

describe('ProsodyEmotionAnalyzer', () => {
  it('an excited voice reads as more aroused, livelier and faster than a calm one', () => {
    const last = (style: typeof CALM) => {
      const out = analyse(new ProsodyEmotionAnalyzer(), featureFrames(concat(silence(1), voice(style))));
      return out[out.length - 1]!;
    };
    const calm = last(CALM);
    const excited = last(EXCITED);
    expect(calm.active && excited.active).toBe(true);
    expect(excited.arousal - calm.arousal).toBeGreaterThan(0.12);
    expect(excited.pitchVariation).toBeGreaterThan(calm.pitchVariation + 0.3);
    expect(excited.speechRate).toBeGreaterThan(calm.speechRate + 0.2);
    expect(excited.energy).toBeGreaterThan(calm.energy);
  });

  it('keeps a calm but melodic Sol-style reply below a brighter, louder reply', () => {
    const p = new ProsodyEmotionAnalyzer();
    // RU Voice capture: the calm reply had less energy and a much darker spectrum, but more
    // pitch variation. These feature values are intentionally close so a pitch-heavy heuristic
    // cannot accidentally classify the calm reply as the more aroused one.
    const high = speech({ energy: 0.844, relativePitch: 0.22, pitchVariation: 2.56, spectralCentroid: 945 });
    const low = speech({ energy: 0.783, relativePitch: -0.88, pitchVariation: 3.43, spectralCentroid: 591 });
    // Give the channel a stable voice baseline first, as it has during a real conversation.
    analyse(p, repeat(speech({ energy: 0.81, pitchVariation: 3, spectralCentroid: 750 }), 5));
    analyse(p, repeat(high, 3));
    const energetic = p.frame().arousal;
    analyse(p, repeat(low, 3));
    const calm = p.frame().arousal;
    expect(energetic - calm).toBeGreaterThan(0.08);
  });

  it('heuristics alone cap valence confidence low', () => {
    const out = analyse(new ProsodyEmotionAnalyzer(), featureFrames(concat(silence(1), voice(EXCITED))));
    const f = out[out.length - 1]!;
    expect(f.mode).toBe('heuristic');
    expect(f.valenceConfidence).toBeLessThanOrEqual(0.25 + 1e-9);
    expect(f.confidence).toBeGreaterThan(f.valenceConfidence);
  });

  it('independent channels: feeding one analyser never changes another', () => {
    const user = new ProsodyEmotionAnalyzer();
    const assistant = new ProsodyEmotionAnalyzer();
    const reference = new ProsodyEmotionAnalyzer();
    const loud = featureFrames(concat(silence(1), voice(EXCITED)));
    const quiet = featureFrames(concat(silence(1), voice(CALM)));
    for (let i = 0; i < Math.min(loud.length, quiet.length); i++) {
      user.push(loud[i]!, FRAME_DT);
      assistant.push(quiet[i]!, FRAME_DT);
      reference.push(quiet[i]!, FRAME_DT);
    }
    expect(assistant.frame()).toEqual(reference.frame());
    expect(user.frame()).not.toEqual(assistant.frame());
    // Tuning one channel's config does not leak into the other or into the defaults.
    user.config.arousalWeights.energy = 0;
    expect(assistant.config.arousalWeights.energy).toBeGreaterThan(0);
    expect(new ProsodyEmotionAnalyzer().config.arousalWeights.energy).toBeGreaterThan(0);
    // A model estimate for one channel stays in that channel.
    user.setModelEstimate({ arousal: 1, valence: 1, confidence: 1 });
    assistant.push(quiet[0]!, FRAME_DT);
    reference.push(quiet[0]!, FRAME_DT);
    expect(assistant.frame()).toEqual(reference.frame());
  });

  it('smoothing: a sudden arousal step 0 → 1 does not reach 1 at once', () => {
    const p = new ProsodyEmotionAnalyzer({ modelArousalWeight: 1, baselineWeight: 0 });
    analyse(p, repeat(speech({ energy: 0, pitchVariation: 0, spectralCentroid: 0 }), 3));
    const before = p.value.arousal;
    expect(before).toBeLessThan(0.2);
    p.setModelEstimate({ arousal: 1, valence: 0, confidence: 1 });
    const step = analyse(p, repeat(speech({ energy: 1 }), 0.13));
    expect(step).toHaveLength(1);
    expect(step[0]!.arousal).toBeLessThan(0.5);
    // …but gets there within a couple of seconds.
    for (let i = 0; i < 12; i++) {
      p.setModelEstimate({ arousal: 1, valence: 0, confidence: 1 });
      analyse(p, repeat(speech({ energy: 1 }), 0.25));
    }
    expect(p.value.arousal).toBeGreaterThan(0.8);
  });

  it('hysteresis: jitter around a value does not move the output', () => {
    const p = new ProsodyEmotionAnalyzer({ baselineWeight: 0 });
    analyse(p, repeat(speech({ energy: 0.5 }), 4));
    const settled = p.value.energy;
    const noise = rng(3);
    const out = analyse(p, repeat(() => speech({ energy: 0.5 + noise() * 0.03 }), 3));
    for (const f of out) expect(Math.abs(f.energy - settled)).toBeLessThan(0.02);
  });

  it('silence: active goes false and the output returns to neutral smoothly', () => {
    const p = new ProsodyEmotionAnalyzer();
    analyse(p, featureFrames(concat(silence(1), voice(EXCITED))));
    const peak = p.frame();
    expect(peak.active).toBe(true);
    const out = analyse(p, repeat(SILENT_USER_VOICE_FRAME, 8));
    const off = out.findIndex((f) => !f.active);
    expect(off).toBeGreaterThan(-1);
    expect(off * 0.125).toBeLessThan(2);
    // Smooth: no step bigger than a fraction of the peak between consecutive frames.
    let prev = peak.arousal;
    for (const f of out) {
      expect(prev - f.arousal).toBeLessThan(0.15);
      expect(f.arousal).toBeLessThanOrEqual(prev + 1e-9);
      prev = f.arousal;
    }
    // Right after speech the influence is still there; after the tail it's exactly neutral.
    expect(out[2]!.arousal).toBeGreaterThan(0.05);
    const end = out[out.length - 1]!;
    expect(end.arousal).toBe(0);
    expect(end.confidence).toBe(0);
    expect(end.valence).toBe(0);
  });

  it('a trusted model estimate raises valence confidence and moves valence', () => {
    const p = new ProsodyEmotionAnalyzer();
    p.setMode('ml-wasm');
    for (let i = 0; i < 16; i++) {
      p.setModelEstimate({ arousal: 0.8, valence: 0.7, confidence: 0.8 });
      analyse(p, repeat(speech(), 0.25));
    }
    expect(p.value.mode).toBe('ml-wasm');
    expect(p.value.valence).toBeGreaterThan(0.4);
    expect(p.value.valenceConfidence).toBeGreaterThan(0.5);
  });

  it('tension: a bright, loud, monotone voice reads as tense; a soft lively one does not', () => {
    const tense = new ProsodyEmotionAnalyzer();
    analyse(tense, repeat(speech({ energy: 1, spectralCentroid: 3000, pitchVariation: 0 }), 4));
    const soft = new ProsodyEmotionAnalyzer();
    analyse(soft, repeat(speech({ energy: 0.3, spectralCentroid: 600, pitchVariation: 3 }), 4));
    expect(tense.value.tension).toBeGreaterThan(0.6);
    expect(soft.value.tension).toBeLessThan(0.1);
  });
});

describe('EmotionModelHost', () => {
  const spec: EmotionModelSpec = {
    url: 'model.onnx',
    sampleRate: 16000,
    windowSeconds: 1,
    arousalIndex: 0,
    valenceIndex: 2,
    outputRange: [0, 1],
    trust: 0.7,
    inferInterval: 0.25,
  };
  const activeAnalyzer = () => {
    const p = new ProsodyEmotionAnalyzer();
    analyse(p, repeat(speech(), 1));
    return p;
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('reports ml-webgpu / ml-wasm by backend and feeds estimates into the channel that asked', async () => {
    const seen: number[] = [];
    const model: EmotionModel = {
      backend: 'wasm',
      infer: async (s) => {
        seen.push(s.length);
        return { arousal: 0.9, valence: 0.5, confidence: 0.7 };
      },
      dispose() {},
    };
    const host = new EmotionModelHost(spec, async () => model, { logger: silentLogger() });
    const user = activeAnalyzer();
    const assistant = new ProsodyEmotionAnalyzer();
    host.attach('user', user);
    host.attach('assistant', assistant);
    expect(await host.load()).toBe('ready');
    expect(user.mode).toBe('ml-wasm');
    expect(assistant.mode).toBe('ml-wasm');
    // 48 kHz in, resampled to the model's 16 kHz window.
    host.pushAudio('user', new Float32Array(48000 * 1.2), 48000);
    host.pushAudio('assistant', new Float32Array(48000 * 1.2), 48000);
    await tick();
    expect(seen).toEqual([16000]); // assistant is silent: not worth a model run
    expect(host.inferenceCount).toBe(1);

    const gpu = new EmotionModelHost(spec, async () => ({ ...model, backend: 'webgpu' }));
    const p = new ProsodyEmotionAnalyzer();
    gpu.attach('x', p);
    await gpu.load();
    expect(p.mode).toBe('ml-webgpu');
  });

  it('model that fails to load → fallback, analyser keeps working on prosody', async () => {
    const log = silentLogger();
    const host = new EmotionModelHost(spec, async () => {
      throw new Error('no WebGPU and no WASM');
    }, { logger: log });
    const p = activeAnalyzer();
    host.attach('user', p);
    expect(await host.load()).toBe('failed');
    expect(p.mode).toBe('fallback');
    host.pushAudio('user', new Float32Array(32000));
    const out = analyse(p, repeat(speech(), 1));
    expect(out.at(-1)!.mode).toBe('fallback');
    expect(out.at(-1)!.active).toBe(true);
    expect(log.messages.join('\n')).toMatch(/failed to load/);
  });

  it('repeated inference failures → fallback', async () => {
    const host = new EmotionModelHost(
      spec,
      async () => ({ backend: 'wasm', infer: async () => Promise.reject(new Error('boom')), dispose() {} }),
      { logger: silentLogger(), maxFailures: 2 },
    );
    const p = activeAnalyzer();
    host.attach('user', p);
    await host.load();
    for (let i = 0; i < 4; i++) {
      host.pushAudio('user', new Float32Array(16000));
      await tick();
    }
    expect(host.status).toBe('failed');
    expect(p.mode).toBe('fallback');
  });

  it('a runtime that hangs instead of failing → fallback after the timeout', async () => {
    const host = new EmotionModelHost(spec, () => new Promise(() => {}), { logger: silentLogger(), loadTimeoutMs: 20 });
    const p = activeAnalyzer();
    host.attach('user', p);
    expect(await host.load()).toBe('failed');
    expect(host.error).toMatch(/timed out/);
    expect(p.mode).toBe('fallback');

    const stuck = new EmotionModelHost(
      spec,
      async () => ({ backend: 'wasm', infer: () => new Promise(() => {}), dispose() {} }),
      { logger: silentLogger(), inferTimeoutMs: 10, maxFailures: 1 },
    );
    const q = activeAnalyzer();
    stuck.attach('user', q);
    await stuck.load();
    stuck.pushAudio('user', new Float32Array(16000));
    await new Promise((r) => setTimeout(r, 40));
    expect(stuck.status).toBe('failed');
    expect(q.mode).toBe('fallback');
  });

  it('readEstimate maps raw outputs to arousal [0,1] and valence [−1,1]', () => {
    expect(readEstimate(spec, [1, 0.5, 0])).toEqual({ arousal: 1, valence: -1, confidence: 0.7 });
    expect(readEstimate({ ...spec, outputRange: [-1, 1] }, [0, 0, 1])).toEqual({ arousal: 0.5, valence: 1, confidence: 0.7 });
    expect(readEstimate(spec, [NaN, 0, NaN]).arousal).toBe(0.5);
  });
});

// --- Mixer / avatar ------------------------------------------------------------------------------------------

const idlePose = { ...EMPTY_PROCEDURAL_POSE, headYaw: 0.02, headPitch: 0.01, headRoll: -0.01, breath: 0.5, gazeYaw: 4, gazePitch: 2 };
const frame = (over: Partial<EmotionFrame>): EmotionFrame => ({ ...NEUTRAL_EMOTION, active: true, ...over });
const inputs = (over: Partial<EmotionInputs>): EmotionInputs => ({ ...NEUTRAL_EMOTION_INPUTS, ...over });

describe('BehaviorMixer emotion', () => {
  it('confidence ≈ 0 → practically neutral output, whatever the values', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.speaking) };
    const wild = frame({ arousal: 1, valence: -1, tension: 1, pitchLift: 1, confidence: 0, valenceConfidence: 0 });
    const out = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: wild, user: wild })) };
    for (const [k, v] of Object.entries(base)) expect(out[k as keyof typeof out], k).toBeCloseTo(v as number, 9);
    const low = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: { ...wild, confidence: 0.02 } })) };
    expect(Math.abs(low.headYaw / base.headYaw - 1)).toBeLessThan(0.01);
    for (const e of EMOTION_EXPRESSIONS) expect(low[e], e).toBeLessThan(0.01);
  });

  it('assistant high arousal → more head/body motion, within bounds', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.speaking) };
    const hi = frame({ arousal: 1, confidence: 1, pitchLift: 1 });
    const out = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: hi })) };
    const lo = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: frame({ arousal: 0, confidence: 1 }) })) };
    const gain = out.headYaw / base.headYaw;
    expect(gain).toBeGreaterThan(1.2);
    expect(gain).toBeLessThanOrEqual(1 + DEFAULT_EMOTION_MIX.assistantHeadMotion + 1e-9);
    expect(lo.headYaw / base.headYaw).toBeLessThan(0.8);
    expect(out.breath).toBeGreaterThan(base.breath);
    expect(out.lean).toBeGreaterThan(base.lean);
    expect(out.lean - base.lean).toBeLessThanOrEqual(DEFAULT_EMOTION_MIX.assistantLean + 1e-9);
    expect(out.surprised).toBeGreaterThan(0);
    expect(out.surprised).toBeLessThanOrEqual(DEFAULT_EMOTION_MIX.surprised + 1e-9);
    // Absurd inputs are clamped to the same bounds.
    const absurd = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: { ...hi, arousal: 50, confidence: 50 } })) };
    expect(absurd.headYaw).toBeCloseTo(out.headYaw, 9);
  });

  it('assistant positive valence → slight smile; tension → brows, reduced smile; the sum stays in budget', () => {
    const mixer = new BehaviorMixer();
    const warm = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: frame({ valence: 1, confidence: 1, valenceConfidence: 1, arousal: 0.5 }) })) };
    expect(warm.happy).toBeGreaterThan(0.2);
    expect(warm.happy).toBeLessThanOrEqual(DEFAULT_EMOTION_MIX.smile + 1e-9);
    expect(warm.relaxed).toBeGreaterThan(0);
    const tense = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: frame({ valence: 1, confidence: 1, valenceConfidence: 1, arousal: 0.5, tension: 1 }) })) };
    expect(tense.angry).toBeGreaterThan(0);
    expect(tense.happy).toBeLessThan(warm.happy * 0.1);
    const all = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: frame({ valence: -1, arousal: 1, tension: 1, pitchLift: 1, confidence: 1, valenceConfidence: 1 }) })) };
    const sum = EMOTION_EXPRESSIONS.reduce((a, e) => a + all[e], 0);
    expect(sum).toBeLessThanOrEqual(DEFAULT_EMOTION_MIX.expressionBudget + 1e-9);
  });

  it('userEmotion never changes the mouth visemes (nor does assistantEmotion)', () => {
    const mixer = new BehaviorMixer();
    const mouth = { aa: 0.7, ih: 0.1, ou: 0.2, ee: 0.05, oh: 0.3 };
    const wild = frame({ arousal: 1, valence: 1, tension: 1, pitchLift: 1, confidence: 1, valenceConfidence: 1 });
    for (const state of ['listening', 'speaking', 'thinking'] as const) {
      const out = mixer.compose(idlePose, STATE_PROFILES[state], mouth, undefined, inputs({ user: wild, assistant: wild }));
      expect({ aa: out.aa, ih: out.ih, ou: out.ou, ee: out.ee, oh: out.oh }).toEqual(mouth);
    }
  });

  it('user arousal → steadier head and gaze, a small lean; positive valence → small reciprocal smile; no mirroring', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.listening) };
    const excitedUser = frame({ arousal: 1, confidence: 1, valence: 1, valenceConfidence: 1 });
    const out = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, undefined, inputs({ user: excitedUser })) };
    expect(Math.abs(out.headYaw)).toBeLessThan(Math.abs(base.headYaw));
    expect(Math.abs(out.gazeYaw - STATE_PROFILES.listening.gazeYawOffset)).toBeLessThan(Math.abs(base.gazeYaw - STATE_PROFILES.listening.gazeYawOffset));
    expect(out.lean).toBeGreaterThan(base.lean);
    expect(out.happy).toBeGreaterThan(0);
    expect(out.happy).toBeLessThanOrEqual(DEFAULT_EMOTION_MIX.userSmile + 1e-9);
    // Not the assistant's livelier head: an aroused user makes the avatar calmer, not more animated.
    expect(out.surprised).toBe(0);
    // User emotion has no weight while the assistant speaks (the mic is mostly echo then).
    const speaking = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ user: excitedUser })) };
    const speakingBase = { ...mixer.compose(idlePose, STATE_PROFILES.speaking) };
    expect(speaking).toEqual(speakingBase);
  });

  it('user tension neutralises the avatar expression', () => {
    const mixer = new BehaviorMixer();
    const warm = frame({ valence: 1, confidence: 1, valenceConfidence: 1 });
    const calm = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, undefined, inputs({ user: warm })) };
    const tense = { ...mixer.compose(idlePose, STATE_PROFILES.listening, 0, undefined, inputs({ user: { ...warm, tension: 1 } })) };
    expect(tense.happy).toBeLessThan(calm.happy * 0.5);
  });

  it('debug gains switch a channel off', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.speaking) };
    const hi = frame({ arousal: 1, valence: 1, confidence: 1, valenceConfidence: 1 });
    const off = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, undefined, inputs({ assistant: hi, assistantGain: 0 })) };
    expect(off).toEqual(base);
  });
});

describe('EmotionChannels + AvatarController', () => {
  const makeController = () => {
    const controller = new AvatarController({ idle: new AvatarIdleController({ random: () => 0.5 }) });
    const emotion = new EmotionChannels();
    controller.setEmotionSource(emotion);
    return { controller, emotion };
  };
  const run = (controller: AvatarController, emotion: EmotionChannels, seconds: number, feed?: () => void) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      if (feed && Math.round(t * 60) % 8 === 0) feed();
      controller.update(1 / 60);
    }
    return emotion.value;
  };

  it('channels are independent and decay smoothly to neutral when frames stop', () => {
    const { controller, emotion } = makeController();
    const hi = frame({ arousal: 0.9, valence: 0.5, confidence: 0.8, valenceConfidence: 0.2 });
    run(controller, emotion, 1, () => emotion.push('assistant', hi));
    expect(emotion.value.assistant.arousal).toBeGreaterThan(0.8);
    expect(emotion.value.user).toEqual({ ...NEUTRAL_EMOTION, mode: 'heuristic' });
    const trail: number[] = [];
    for (let t = 0; t < 5; t += 1 / 60) {
      controller.update(1 / 60);
      trail.push(emotion.value.assistant.arousal);
    }
    for (let i = 1; i < trail.length; i++) expect(trail[i - 1]! - trail[i]!).toBeLessThan(0.05);
    expect(trail[Math.round(0.9 * 60)]!).toBeGreaterThan(0.3);
    expect(trail.at(-1)!).toBeLessThan(0.01);
  });

  it('interruption: assistant speaking + user starts → listening, assistant influence ↓, user influence ↑', () => {
    const { controller, emotion } = makeController();
    const a = frame({ arousal: 0.9, confidence: 0.8 });
    const u = frame({ arousal: 0.8, confidence: 0.7 });
    controller.setState('speaking');
    run(controller, emotion, 1.5, () => {
      emotion.push('assistant', a);
      emotion.push('user', u);
    });
    const before = { ...controller.emotionMix };
    expect(before.assistant).toBeGreaterThan(0.6);
    expect(before.user).toBe(0);
    controller.setState('listening'); // the resolver's verdict on a real barge-in
    run(controller, emotion, 1, () => {
      emotion.push('assistant', a);
      emotion.push('user', u);
    });
    const after = controller.emotionMix;
    expect(after.assistant).toBeLessThan(before.assistant * 0.3);
    expect(after.user).toBeGreaterThan(0.5);
  });

  it('debug switch fades a channel out and back in', () => {
    const { controller, emotion } = makeController();
    controller.setState('speaking');
    const a = frame({ arousal: 0.9, confidence: 0.8 });
    run(controller, emotion, 1, () => emotion.push('assistant', a));
    emotion.setEnabled('assistant', false);
    controller.update(1 / 60);
    expect(controller.emotionMix.assistant).toBeGreaterThan(0.3); // fades, doesn't snap
    run(controller, emotion, 2, () => emotion.push('assistant', a));
    expect(controller.emotionMix.assistant).toBeLessThan(0.01);
    expect(emotion.isEnabled('user')).toBe(true);
  });
});

describe('Avatar expression composition', () => {
  it('emotion writes emotion presets, lip sync keeps articulation despite VRM overrideMouth "blend"', () => {
    const vrm = createFakeVrm({ overrides: { happy: { overrideMouth: 'blend', overrideBlink: 'blend' }, sad: { overrideMouth: 'blend' } } });
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, aa: 0.5, ee: 0.2, blink: 0.4, happy: 0.3 });
    avatar.update(0);
    expect(vrm.values.get('happy')).toBeCloseTo(0.3);
    // three-vrm will multiply mouth presets by 1 − 0.3: pre-compensated so the rendered aa is still 0.5.
    expect(vrm.values.get('aa')! * (1 - 0.3)).toBeCloseTo(0.5);
    expect(vrm.values.get('ee')! * (1 - 0.3)).toBeCloseTo(0.2);
    expect(vrm.values.get('blink')! * (1 - 0.3)).toBeCloseTo(0.4);
    // No override, no compensation.
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, aa: 0.5, relaxed: 0.3 });
    avatar.update(0);
    expect(vrm.values.get('aa')).toBeCloseTo(0.5);
  });

  it('emotion presets that "block" the mouth are left alone (lip sync would stop), manual still works', () => {
    const log = silentLogger();
    const vrm = createFakeVrm({ overrides: { happy: { overrideMouth: 'block' } } });
    const avatar = new Avatar(vrm, { logger: log });
    expect(log.messages.join()).toMatch(/happy/);
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, aa: 0.6, happy: 0.3 });
    avatar.update(0);
    expect(vrm.values.get('happy')).toBe(0);
    expect(vrm.values.get('aa')).toBeCloseTo(0.6);
    avatar.setExpression('happy', 0.5);
    avatar.update(0);
    expect(vrm.values.get('happy')).toBe(0.5);
  });

  it('manual layer combines with the emotion layer via max()', () => {
    const vrm = createFakeVrm();
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    avatar.setExpression('relaxed', 0.1);
    avatar.setProcedural({ ...EMPTY_PROCEDURAL_POSE, relaxed: 0.25, surprised: 0.1 });
    avatar.update(0);
    expect(vrm.values.get('relaxed')).toBeCloseTo(0.25);
    expect(vrm.values.get('surprised')).toBeCloseTo(0.1);
  });
});
