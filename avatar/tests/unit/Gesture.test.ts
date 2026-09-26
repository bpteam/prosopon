import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { NEUTRAL_EMOTION, type EmotionFrame } from '../../src/audio/emotion/EmotionFrame';
import { Avatar, type HumanBoneName } from '../../src/avatar/Avatar';
import { AvatarController } from '../../src/avatar/AvatarController';
import { AvatarIdleController } from '../../src/avatar/AvatarIdleController';
import type { AvatarState } from '../../src/avatar/AvatarStateProfiles';
import { STATE_PROFILES } from '../../src/avatar/AvatarStateProfiles';
import { BehaviorMixer } from '../../src/avatar/BehaviorMixer';
import { BODY_POSE_KEYS, POSE_LIMITS } from '../../src/avatar/BodyPose';
import { NEUTRAL_EMOTION_INPUTS, type EmotionInputs } from '../../src/avatar/EmotionExpression';
import {
  ARM_BONES,
  GESTURE_TYPES,
  NEUTRAL_GESTURE,
  createGestureFrame,
  seededRandom,
  type GestureContext,
  type GestureFrame,
  type GestureType,
} from '../../src/avatar/gesture/Gesture';
import { GESTURE_CONFIG, GESTURE_LIMITS } from '../../src/avatar/gesture/GestureConfig';
import { GestureEngine, type GestureEngineOptions } from '../../src/avatar/gesture/GestureEngine';
import { NEUTRAL_REACTION } from '../../src/avatar/UserReaction';
import { REST_POSE } from '../../src/config';
import { createFakeVrm, silentLogger } from './fakeVrm';

const FPS = 1 / 60;

const emotion = (over: Partial<EmotionFrame> = {}): EmotionFrame => ({ ...NEUTRAL_EMOTION, ...over });
const EXCITED = emotion({ active: true, arousal: 0.9, energy: 0.8, pitchVariation: 0.7, confidence: 0.9 });
const CALM = emotion({ active: true, arousal: 0.2, energy: 0.3, pitchVariation: 0.1, confidence: 0.9 });

function ctx(over: Partial<GestureContext> = {}): GestureContext {
  return {
    conversationState: 'idle',
    userSpeaking: false,
    assistantSpeaking: false,
    userEmotion: NEUTRAL_EMOTION,
    assistantEmotion: NEUTRAL_EMOTION,
    utteranceEnds: 0,
    lastUtteranceDuration: 0,
    ...over,
  };
}

function engine(options: GestureEngineOptions = {}, seed = 1): GestureEngine {
  return new GestureEngine({ random: seededRandom(seed), ...options });
}

/** Largest absolute offset of a frame. */
function magnitude(f: Readonly<GestureFrame>): number {
  let m = Math.max(
    Math.abs(f.head.yaw), Math.abs(f.head.pitch), Math.abs(f.head.roll),
    Math.abs(f.body.lean), Math.abs(f.body.yaw), Math.abs(f.body.roll),
    Math.abs(f.shoulders.left), Math.abs(f.shoulders.right),
  );
  for (const b of ARM_BONES) m = Math.max(m, Math.abs(f.arms[b].x), Math.abs(f.arms[b].y), Math.abs(f.arms[b].z));
  return m;
}

function armMagnitude(f: Readonly<GestureFrame>): number {
  let m = 0;
  for (const b of ARM_BONES) m = Math.max(m, Math.abs(f.arms[b].x), Math.abs(f.arms[b].y), Math.abs(f.arms[b].z));
  return m;
}

/** Runs `seconds` at `dt`; returns the types started, in order. */
function run(e: GestureEngine, c: GestureContext, seconds: number, dt = FPS): GestureType[] {
  const started: GestureType[] = [];
  let count = e.history.gestureCount;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) {
    e.update(dt, c);
    if (e.history.gestureCount !== count) {
      count = e.history.gestureCount;
      started.push(e.history.lastGestureType!);
    }
  }
  return started;
}

describe('GestureEngine scheduler', () => {
  it('respects the cooldown after every gesture', () => {
    const e = engine({ config: { rateScale: 200 } });
    const c = ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED });
    let lastEnd = -Infinity;
    let wasActive = false;
    let t = 0;
    const gaps: number[] = [];
    for (let i = 0; i < 60 * 120; i++) {
      e.update(FPS, c);
      t += FPS;
      if (wasActive && !e.current.active) lastEnd = t;
      if (!wasActive && e.current.active && lastEnd > -Infinity) gaps.push(t - lastEnd);
      wasActive = e.current.active;
    }
    const minCooldown = Math.min(...GESTURE_TYPES.map((g) => GESTURE_CONFIG.types[g].cooldown[0]));
    expect(gaps.length).toBeGreaterThan(10);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(minCooldown - 2 * FPS);
    // Randomised, not a fixed interval.
    expect(new Set(gaps.map((g) => g.toFixed(2))).size).toBeGreaterThan(5);
  });

  it('gesture rate follows assistant arousal, bounded; low arousal → almost none', () => {
    const count = (a: EmotionFrame) =>
      run(engine({}, 7), ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: a }), 600).length;
    const calm = count(CALM);
    const excited = count(EXCITED);
    expect(excited).toBeGreaterThan(calm * 2);
    // "Rare": even an excited assistant gets well under one gesture every 3 s.
    expect(excited).toBeLessThan(600 / 3);
    expect(calm).toBeLessThan(600 / 20);
  });

  it('hands: only while the assistant speaks with high arousal; never listening/thinking/idle', () => {
    const hands = (state: AvatarState, a: EmotionFrame, userSpeaking = false) =>
      run(engine({ config: { rateScale: 5 } }, 3), ctx({ conversationState: state, assistantSpeaking: state === 'speaking', assistantEmotion: a, userSpeaking }), 600).filter(
        (g) => g === 'hand-emphasis',
      ).length;
    expect(hands('speaking', EXCITED)).toBeGreaterThan(0);
    expect(hands('speaking', CALM)).toBe(0);
    for (const s of ['idle', 'listening', 'thinking'] as const) expect(hands(s, EXCITED)).toBe(0);
    expect(hands('listening', EXCITED, true)).toBe(0);
  });

  it('context: thinking → mostly head tilt, listening → no body-size gestures beyond a small shift', () => {
    const thinking = run(engine({ config: { rateScale: 5 } }, 5), ctx({ conversationState: 'thinking' }), 900);
    const tilts = thinking.filter((g) => g === 'head-tilt').length;
    expect(tilts / thinking.length).toBeGreaterThan(0.5);
    expect(thinking).not.toContain('hand-emphasis');
  });

  it('avoids repeating the same gesture back to back', () => {
    const seq = run(engine({ config: { rateScale: 10 } }, 11), ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED }), 1800);
    const repeats = seq.slice(1).filter((g, i) => g === seq[i]).length;
    const noPenalty = run(
      engine({ config: { rateScale: 10, repeatPenalty: 1 } }, 11),
      ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED }),
      1800,
    );
    const repeatsNoPenalty = noPenalty.slice(1).filter((g, i) => g === noPenalty[i]).length;
    expect(seq.length).toBeGreaterThan(50);
    expect(repeats / seq.length).toBeLessThan(repeatsNoPenalty / noPenalty.length);
    expect(repeats / seq.length).toBeLessThan(0.2);
  });

  it('disabled: nothing starts, triggers are refused, a running gesture releases smoothly', () => {
    const e = engine({ config: { rateScale: 100 } });
    const c = ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED });
    e.enabled = false;
    expect(run(e, c, 60)).toEqual([]);
    expect(e.trigger('nod')).toBe(false);
    e.enabled = true;
    e.auto = false;
    expect(e.trigger('head-tilt')).toBe(true);
    run(e, c, 0.8);
    const before = magnitude(e.current);
    expect(before).toBeGreaterThan(0.01);
    e.enabled = false;
    e.update(FPS, c);
    expect(magnitude(e.current)).toBeGreaterThan(before * 0.8); // no snap
    run(e, c, GESTURE_CONFIG.cancelRelease + 0.05);
    expect(e.current.active).toBe(false);
    expect(magnitude(e.current)).toBe(0);
  });

  it('forced trigger ignores probability and cooldown, not the hands rule', () => {
    const e = engine({ config: { auto: false, rateScale: 0 } });
    const c = ctx();
    expect(e.trigger('nod')).toBe(true);
    run(e, c, 1);
    expect(e.cooldownRemaining).toBeGreaterThan(0);
    expect(e.trigger('double-nod')).toBe(true);
    e.update(FPS, c);
    expect(e.current.type).toBe('double-nod');
    // A new forced trigger during a gesture: short release, then it starts.
    expect(e.trigger('body-shift')).toBe(true);
    run(e, c, GESTURE_CONFIG.cancelRelease + 0.05);
    expect(e.current.type).toBe('body-shift');
    const listening = ctx({ conversationState: 'listening', userSpeaking: true });
    e.update(FPS, listening);
    expect(e.trigger('hand-emphasis')).toBe(false);
  });

  it('same seed and input → same gesture sequence; another seed → another one', () => {
    const c = () => ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED });
    const a = run(engine({ config: { rateScale: 5 } }, 42), c(), 600);
    const b = run(engine({ config: { rateScale: 5 } }, 42), c(), 600);
    const other = run(engine({ config: { rateScale: 5 } }, 43), c(), 600);
    expect(a.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
    expect(other).not.toEqual(a);
  });
});

describe('GestureEngine lifecycle', () => {
  it('nod: neutral → nod → neutral with no residual offset', () => {
    const e = engine({ config: { auto: false } });
    const c = ctx();
    e.update(FPS, c);
    expect(e.current).toMatchObject({ active: false, type: null });
    e.trigger('nod', 1);
    let peak = 0;
    const phases = new Set<string>();
    for (let i = 0; i < 60; i++) {
      e.update(FPS, c);
      peak = Math.max(peak, e.current.head.pitch);
      phases.add(e.current.phase);
    }
    expect(peak).toBeGreaterThan(GESTURE_CONFIG.types.nod.headPitch * 0.95);
    expect(peak).toBeLessThanOrEqual(GESTURE_CONFIG.types.nod.headPitch + 1e-12);
    expect([...phases]).toEqual(expect.arrayContaining(['prepare', 'attack', 'release']));
    expect(e.current.active).toBe(false);
    expect(magnitude(e.current)).toBe(0);
  });

  it('every gesture type starts and ends at zero, without jumps', () => {
    for (const type of GESTURE_TYPES) {
      const e = engine({ config: { auto: false } });
      const c = ctx({ conversationState: 'speaking', assistantSpeaking: true });
      e.trigger(type, 1);
      let prev = 0;
      let maxStep = 0;
      for (let i = 0; i < 60 * 4; i++) {
        e.update(FPS, c);
        const m = magnitude(e.current);
        maxStep = Math.max(maxStep, Math.abs(m - prev));
        prev = m;
      }
      expect(prev, type).toBe(0);
      // Largest per-frame change stays a small share of the amplitude (no instant jump to the peak).
      expect(maxStep, type).toBeLessThan(0.04);
    }
  });

  it('cancel: smooth release to neutral within cancelRelease', () => {
    const e = engine({ config: { auto: false } });
    const c = ctx({ conversationState: 'speaking', assistantSpeaking: true });
    e.trigger('head-tilt', 1);
    run(e, c, 0.7);
    const start = magnitude(e.current);
    expect(start).toBeGreaterThan(0.03);
    e.cancel();
    const trace: number[] = [];
    for (let t = 0; t < GESTURE_CONFIG.cancelRelease + 0.05; t += FPS) {
      e.update(FPS, c);
      trace.push(magnitude(e.current));
    }
    expect(trace[0]).toBeGreaterThan(start * 0.9);
    for (let i = 1; i < trace.length; i++) expect(trace[i]!).toBeLessThanOrEqual(trace[i - 1]! + 1e-12);
    expect(trace.at(-1)).toBe(0);
    expect(e.current.active).toBe(false);
  });

  it('interruption: an assistant hand gesture releases fast when the user takes the floor', () => {
    const e = engine({ config: { auto: false } });
    const speaking = ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED });
    e.update(FPS, speaking);
    e.trigger('hand-emphasis', 1);
    run(e, speaking, 0.4);
    expect(armMagnitude(e.current)).toBeGreaterThan(0.05);
    const listening = ctx({ conversationState: 'listening', userSpeaking: true, assistantEmotion: EXCITED });
    const released = run(e, listening, GESTURE_CONFIG.interruptRelease + 2 * FPS);
    expect(released).toEqual([]);
    expect(e.current.active).toBe(false);
    // No large arm movement afterwards, whatever the scheduler rolls while the user talks.
    e.auto = true;
    e.config.rateScale = 50;
    for (let i = 0; i < 60 * 60; i++) {
      e.update(FPS, listening);
      expect(armMagnitude(e.current)).toBe(0);
    }
  });

  it('progress and shape are frame-rate independent (30/60/120 FPS)', () => {
    const sample = (fps: number) => {
      const e = engine({ config: { auto: false } });
      const c = ctx();
      e.trigger('head-tilt', 1);
      const values: number[] = [];
      const dt = 1 / fps;
      // Sample every 1/30 s.
      for (let i = 1; i <= fps * 3; i++) {
        e.update(dt, c);
        if (i % (fps / 30) === 0) values.push(e.current.head.roll, e.current.progress);
      }
      return values;
    };
    const a = sample(30);
    const b = sample(60);
    const c = sample(120);
    for (let i = 0; i < a.length; i++) {
      expect(b[i]).toBeCloseTo(a[i]!, 9);
      expect(c[i]).toBeCloseTo(a[i]!, 9);
    }
  });

  it('scheduler rate is frame-rate independent (Poisson hazard)', () => {
    const count = (fps: number) => {
      let n = 0;
      for (let seed = 1; seed <= 4; seed++) {
        n += run(engine({}, seed), ctx({ conversationState: 'speaking', assistantSpeaking: true, assistantEmotion: EXCITED }), 900, 1 / fps).length;
      }
      return n;
    };
    const n30 = count(30);
    const n120 = count(120);
    expect(n30).toBeGreaterThan(40);
    expect(Math.abs(n120 - n30) / n30).toBeLessThan(0.2);
  });
});

describe('user utterance → nod', () => {
  const listening = (over: Partial<GestureContext> = {}) => ctx({ conversationState: 'thinking', ...over });

  it('meaningful utterance end nods; short ones and ones inside the interval do not', () => {
    const e = engine({ config: { nodOnUtteranceChance: 1, rateScale: 0 } });
    const c = listening();
    e.update(FPS, c);
    c.utteranceEnds = 1;
    c.lastUtteranceDuration = 0.3; // "uh"
    run(e, c, 1);
    expect(e.nods).toBe(0);
    c.utteranceEnds = 2;
    c.lastUtteranceDuration = 1.5;
    run(e, c, 0.5);
    expect(e.nods).toBe(1);
    c.utteranceEnds = 3; // right after: inside nodMinInterval
    run(e, c, 1);
    expect(e.nods).toBe(1);
    run(e, c, GESTURE_CONFIG.nodMinInterval);
    c.utteranceEnds = 4;
    run(e, c, 1);
    expect(e.nods).toBe(2);
  });

  it('an edge between two updates is seen exactly once (counter, not boolean)', () => {
    const e = engine({ config: { nodOnUtteranceChance: 1, nodMinInterval: 0, rateScale: 0 } });
    const c = listening({ lastUtteranceDuration: 1 });
    e.update(FPS, c);
    c.utteranceEnds = 5;
    for (let i = 0; i < 120; i++) e.update(FPS, c);
    expect(e.nods).toBe(1);
  });

  it('double nod needs a long, engaged utterance; heuristic valence alone never counts', () => {
    const doubles = (user: EmotionFrame, duration: number) => {
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const e = engine({ config: { nodOnUtteranceChance: 1, rateScale: 0 } }, seed);
        const c = listening({ userEmotion: user });
        e.update(FPS, c);
        c.utteranceEnds = 1;
        c.lastUtteranceDuration = duration;
        run(e, c, 1.2);
        n += e.started['double-nod'];
      }
      return n;
    };
    const engaged = emotion({ arousal: 0.8, confidence: 0.8 });
    const heuristicPositive = emotion({ arousal: 0.3, valence: 1, valenceConfidence: 0.25, confidence: 0.8 });
    expect(doubles(engaged, 3)).toBeGreaterThan(3);
    expect(doubles(engaged, 1)).toBe(0);
    expect(doubles(heuristicPositive, 3)).toBe(0);
    expect(doubles(emotion({ arousal: 0.3, valence: 1, valenceConfidence: 0.7, confidence: 0.8 }), 3)).toBeGreaterThan(3);
  });

  it('listening: no endless nodding through a long user utterance', () => {
    const e = engine({ config: { rateScale: 20 } }, 9);
    const c = ctx({ conversationState: 'listening', userSpeaking: true, userEmotion: EXCITED });
    run(e, c, 120);
    expect(e.nods).toBeLessThanOrEqual(GESTURE_CONFIG.listeningNodsPerUtterance);
  });
});

describe('BehaviorMixer gesture input', () => {
  const idlePose = { ...new BehaviorMixer().pose, headYaw: 0.02, headPitch: 0.01, headRoll: -0.01, breath: 0.5, blink: 0.4, gazeYaw: 4 };
  const face: EmotionInputs = {
    ...NEUTRAL_EMOTION_INPUTS,
    assistant: emotion({ active: true, arousal: 0.8, valence: 0.8, valenceConfidence: 0.8, confidence: 1, tension: 0.3, pitchLift: 0.5 }),
  };
  const mouth = { aa: 0.6, ih: 0.1, ou: 0.2, ee: 0, oh: 0.3 };

  it('gesture changes only head/body/shoulder/arm offsets: mouth, blink, gaze and emotion expressions are untouched', () => {
    const mixer = new BehaviorMixer();
    const without = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, mouth, NEUTRAL_REACTION, face) };
    const g = createGestureFrame();
    g.active = true;
    g.head.pitch = 0.05;
    g.head.roll = 0.03;
    g.body.yaw = 0.04;
    g.shoulders.left = 0.05;
    g.arms.rightUpperArm.x = -0.2;
    const withG = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, mouth, NEUTRAL_REACTION, face, g) };
    for (const k of ['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'gazeYaw', 'gazePitch', 'breath', 'happy', 'relaxed', 'sad', 'angry', 'surprised'] as const) {
      expect(withG[k], k).toBe(without[k]);
    }
    expect(without.happy).toBeGreaterThan(0);
    expect(withG.headPitch - without.headPitch).toBeCloseTo(0.05);
    expect(withG.headRoll - without.headRoll).toBeCloseTo(0.03);
    expect(withG.headYaw).toBe(without.headYaw);
    expect(withG.bodyYaw).toBeCloseTo(0.04);
    expect(withG.shoulderLeft).toBeCloseTo(0.05);
    expect(withG.rightUpperArmX).toBeCloseTo(-0.2);
  });

  it('clamps any gesture source (intensity 100, NaN, Infinity) to the safety bounds', () => {
    const mixer = new BehaviorMixer();
    const base = { ...mixer.compose(idlePose, STATE_PROFILES.speaking) };
    const huge = createGestureFrame();
    huge.head.yaw = huge.head.pitch = huge.head.roll = 100;
    huge.body.lean = huge.body.yaw = huge.body.roll = -100;
    huge.shoulders.left = 100;
    huge.shoulders.right = Infinity;
    for (const b of ARM_BONES) huge.arms[b].x = huge.arms[b].y = huge.arms[b].z = 100;
    const out = mixer.compose(idlePose, STATE_PROFILES.speaking, 0, NEUTRAL_REACTION, NEUTRAL_EMOTION_INPUTS, huge);
    expect(out.headPitch - base.headPitch).toBeLessThanOrEqual(GESTURE_LIMITS.headPitch + 1e-9);
    expect(Math.abs(out.headYaw)).toBeLessThanOrEqual(POSE_LIMITS.headYaw);
    expect(Math.abs(out.bodyYaw)).toBeLessThanOrEqual(GESTURE_LIMITS.bodyYaw);
    expect(out.shoulderRight).toBe(0); // Infinity → 0, not the limit
    for (const k of BODY_POSE_KEYS) expect(Math.abs(out[k]), k).toBeLessThanOrEqual(Math.max(GESTURE_LIMITS.arm, GESTURE_LIMITS.shoulder));
    const nan = createGestureFrame();
    nan.head.pitch = NaN;
    nan.arms.leftUpperArm.z = NaN;
    const n = { ...mixer.compose(idlePose, STATE_PROFILES.speaking, 0, NEUTRAL_REACTION, NEUTRAL_EMOTION_INPUTS, nan) };
    expect(n).toEqual(base);
  });

  it('a forced gesture at intensity 100 still stays inside the bounds', () => {
    const e = engine({ config: { auto: false, types: { nod: { headPitch: 5 } } } });
    e.trigger('nod', 100);
    const mixer = new BehaviorMixer();
    const base = mixer.compose(idlePose, STATE_PROFILES.idle).headPitch;
    let max = 0;
    for (let i = 0; i < 60; i++) {
      const g = e.update(FPS, ctx());
      max = Math.max(max, mixer.compose(idlePose, STATE_PROFILES.idle, 0, NEUTRAL_REACTION, NEUTRAL_EMOTION_INPUTS, g).headPitch - base);
    }
    expect(max).toBeCloseTo(GESTURE_LIMITS.headPitch);
  });
});

describe('Avatar with gestures', () => {
  function setup(bones?: HumanBoneName[]) {
    const vrm = createFakeVrm({ bones: bones ?? [...createFakeVrm().bones.keys(), 'leftLowerArm', 'rightLowerArm'] });
    const avatar = new Avatar(vrm, { restPose: REST_POSE, logger: silentLogger() });
    const idle = new AvatarIdleController({ config: { enabled: false, blinkEnabled: false } });
    const controller = new AvatarController({ avatar, idle, transitionDuration: 0 });
    const gestures = engine({ config: { auto: false } });
    controller.setGestureSource(gestures);
    return { vrm, avatar, controller, gestures };
  }
  const quat = (vrm: ReturnType<typeof createFakeVrm>, bone: HumanBoneName) =>
    vrm.bones.get(bone)!.quaternion.toArray();

  it('arms return to REST_POSE (not the T-pose) after a hand gesture', () => {
    const { vrm, controller, gestures } = setup();
    controller.setState('speaking');
    controller.update(FPS);
    const rest = { l: quat(vrm, 'leftUpperArm'), r: quat(vrm, 'rightUpperArm'), ll: quat(vrm, 'leftLowerArm'), rl: quat(vrm, 'rightLowerArm') };
    expect(rest.l[3]).toBeLessThan(0.9); // lowered, not identity
    let moved = 0;
    for (let n = 0; n < 6; n++) {
      gestures.trigger('hand-emphasis', 1);
      for (let i = 0; i < 60 * 8; i++) {
        controller.update(FPS);
        moved = Math.max(moved, Math.abs(quat(vrm, 'leftUpperArm')[0]! - rest.l[0]!), Math.abs(quat(vrm, 'rightUpperArm')[0]! - rest.r[0]!));
      }
    }
    expect(moved).toBeGreaterThan(0.01);
    expect(quat(vrm, 'leftUpperArm')).toEqual(rest.l);
    expect(quat(vrm, 'rightUpperArm')).toEqual(rest.r);
    expect(quat(vrm, 'leftLowerArm')).toEqual(rest.ll);
    expect(quat(vrm, 'rightLowerArm')).toEqual(rest.rl);
  });

  it('missing optional bones: no exception; shoulder shift falls back to a chest roll', () => {
    const { vrm, controller, gestures } = setup(['hips', 'spine', 'chest', 'neck', 'head']);
    const chest0 = quat(vrm, 'chest');
    for (const type of GESTURE_TYPES) {
      gestures.trigger(type, 1);
      expect(() => {
        for (let i = 0; i < 60 * 4; i++) controller.update(FPS);
      }).not.toThrow();
    }
    gestures.trigger('shoulder-shift', 1);
    let roll = 0;
    for (let i = 0; i < 60; i++) {
      controller.update(FPS);
      roll = Math.max(roll, Math.abs(quat(vrm, 'chest')[2]! - chest0[2]!));
    }
    expect(roll).toBeGreaterThan(0.001);
    // Head only.
    const headOnly = setup(['head']);
    headOnly.gestures.trigger('body-shift', 1);
    expect(() => {
      for (let i = 0; i < 60 * 4; i++) headOnly.controller.update(FPS);
    }).not.toThrow();
  });

  it('composition: manual + idle + state + emotion + gesture all reach the head bone', () => {
    const vrm = createFakeVrm();
    const avatar = new Avatar(vrm, { logger: silentLogger() });
    const idle = new AvatarIdleController({ config: { enabled: true, blinkEnabled: true }, random: () => 0.3 });
    const controller = new AvatarController({ avatar, idle, transitionDuration: 0 });
    controller.setState('speaking');
    controller.setHeadRotation(0.1, 0.05, -0.02);
    controller.setEmotionSource({ update: () => ({ ...NEUTRAL_EMOTION_INPUTS, assistant: EXCITED }) });
    const g = createGestureFrame();
    g.active = true;
    g.head.pitch = 0.04;
    controller.setGestureSource({ update: () => g, cancel: () => {}, reset: () => {} });
    for (let i = 0; i < 90; i++) controller.update(FPS);
    const withGesture = controller.pose.headPitch;
    // Bone = manual + procedural (idle × state × emotion + offsets + gesture), Euler YXZ.
    const expected = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(0.05 + withGesture, 0.1 + controller.pose.headYaw, -0.02 + controller.pose.headRoll, 'YXZ'),
    );
    const q = vrm.bones.get('head')!.quaternion;
    expect(q.angleTo(expected)).toBeLessThan(1e-6);
    controller.setGestureSource(null);
    controller.update(0);
    expect(withGesture - controller.pose.headPitch).toBeCloseTo(0.04, 6);
    expect(avatar.getBoneRotation('head')).toEqual({ x: 0.05, y: 0.1, z: -0.02 });
  });

  it('long run: 30 minutes of synthetic conversation, no drift, no stuck gesture', () => {
    const { vrm, controller, gestures } = setup();
    gestures.auto = true;
    gestures.config.rateScale = 5;
    const inputs: EmotionInputs = { ...NEUTRAL_EMOTION_INPUTS, assistant: EXCITED, user: CALM };
    controller.setEmotionSource({ update: () => inputs });
    const reaction = { ...NEUTRAL_REACTION };
    controller.setReactionSource({ update: () => reaction });
    controller.update(FPS);
    const bones = ['head', 'neck', 'chest', 'spine', 'leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm'] as const;
    const rest = Object.fromEntries(bones.map((b) => [b, quat(vrm, b)]));
    const states: AvatarState[] = ['listening', 'thinking', 'speaking', 'idle'];
    const out = controller.gesture;
    let t = 0;
    let longest = 0;
    let activeFor = 0;
    let started = 0;
    for (let turn = 0; t < 30 * 60; turn++) {
      const state = states[turn % states.length]!;
      controller.setState(state);
      reaction.speaking = state === 'listening';
      const len = 4 + (turn % 5);
      for (let i = 0; i < len * 60; i++) {
        controller.update(FPS);
        t += FPS;
        // Time since the running gesture started (a preempting gesture starts a new one).
        if (gestures.history.gestureCount !== started) {
          started = gestures.history.gestureCount;
          activeFor = 0;
        }
        activeFor = controller.gesture.active ? activeFor + FPS : 0;
        longest = Math.max(longest, activeFor);
      }
      if (state === 'listening') {
        reaction.speaking = false;
        reaction.utteranceEnds++;
        reaction.lastUtteranceDuration = len;
      }
    }
    expect(gestures.history.gestureCount).toBeGreaterThan(100);
    expect(gestures.nods).toBeGreaterThan(10);
    expect(longest).toBeLessThan(4); // longest configured duration + release
    expect(controller.gesture).toBe(out); // one frame object, reused
    gestures.enabled = false;
    controller.setState('idle');
    for (let i = 0; i < 120; i++) controller.update(FPS);
    for (const b of bones) {
      const q = quat(vrm, b);
      for (let k = 0; k < 4; k++) expect(q[k], b).toBeCloseTo(rest[b]![k]!, 12);
    }
  });
});

describe('contract', () => {
  it('NEUTRAL_GESTURE is immutable', () => {
    expect(Object.isFrozen(NEUTRAL_GESTURE.head)).toBe(true);
    expect(Object.isFrozen(NEUTRAL_GESTURE.arms.leftUpperArm)).toBe(true);
  });
});
